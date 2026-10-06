import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type TrustedSemanticIntentAdmissionV3, requireTrustedSemanticIntentAdmissionV3,
  SemanticIntentStepV3Schema, type SemanticTargetIntentV3 } from './semantic-intent-v3.js';
import { type SemanticGroundingWitnessV1, type SemanticActionExecutionReceiptV1,
  parseSemanticGroundingWitnessV1, parseSemanticActionExecutionReceiptV1,
  SemanticGroundingWitnessV1Schema, SemanticActionExecutionReceiptV1Schema,
  semanticGroundingDigestV1 as hash } from './semantic-grounding-v1.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const eligibleRoles = ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch',
  'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox'];
const categoryRoles: Record<string, string[]> = {
  dropdown: ['combobox', 'listbox'], 'text input': ['textbox', 'searchbox'],
  input: ['textbox', 'searchbox'], checkbox: ['checkbox'], button: ['button'], link: ['link'],
  option: ['option'], radio: ['radio'], textbox: ['textbox'], searchbox: ['searchbox'],
  combobox: ['combobox'], listbox: ['listbox'], control: ['button', 'link', 'checkbox',
    'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'switch'],
};
/** Closed browser-role domain, selected once by the compiler rather than interpreted during replay. */
export function semanticResolvedRolesV10(target: SemanticTargetIntentV3 | null,
  _candidateRoles: string[]): string[] {
  if (!target?.category) return eligibleRoles;
  const key = target.category.toLocaleLowerCase('en-US').trim();
  return categoryRoles[key] ?? (eligibleRoles.includes(key) ? [key] : []);
}
const target = z.strictObject({ role: z.string().min(1).max(40), name: z.string().max(512),
  exactName: z.string().max(512).nullable(), context: z.string().max(1024).nullable(),
  contextProof: z.enum(['none', 'self_category', 'ancestor_text']),
  frame: z.literal('main'), domPath: z.string().max(128), identity: digest });
const domain = z.strictObject({ domainVersion: z.literal('semantic_candidate_domain_v1'),
  completeRequired: z.literal(true), roles: z.array(z.string().min(1).max(40)).min(1).max(16),
  exactName: z.string().max(512).nullable(), context: z.string().max(1024).nullable(),
  groundedCount: z.number().int().min(0).max(100),
  requireGroundedCount: z.boolean(),
  orderedIdentities: z.array(digest).max(100), orderedDomPaths: z.array(z.string().max(128)).max(100),
  selectedIndex: z.number().int().nonnegative().nullable(),
  ordinal: z.number().int().min(1).max(100).nullable(),
  relation: z.strictObject({ kind: z.enum(['same_as_step', 'created_by_step']),
    relatedStepId: id, selectedIdentity: digest }).nullable() });
export const SemanticResolvedDomainV1Schema = domain;
const wait = z.strictObject({ mode: z.enum(['none', 'bounded_resulting_state']),
  timeoutSource: z.literal('trusted_profile_wait_policy') });
const base = { stepId: id, source: z.literal('authored'), sourceWitnessDigest: digest };
export const SemanticResolvedStepV10Schema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('navigate'), url: z.url() }),
  z.strictObject({ ...base, type: z.literal('action'),
    operation: z.enum(['click', 'check', 'uncheck', 'select_option', 'fill']),
    target, domain, argument: z.string().max(1024).nullable(),
    expectedChecked: z.boolean().nullable(),
    option: z.strictObject({ label: z.string().max(512), value: z.string().max(1024),
      ownerIdentity: digest, uniqueOwnedMapping: z.literal(true) }).nullable() }),
  z.strictObject({ ...base, type: z.literal('assert_count'), domain,
    operator: z.enum(['equals', 'at_least', 'at_most']), expected: z.number().int().min(0).max(10000), wait }),
  z.strictObject({ ...base, type: z.literal('assert_boolean'), domain, target,
    property: z.enum(['visible', 'enabled', 'checked']), expected: z.boolean(), wait }),
  z.strictObject({ ...base, type: z.literal('assert_value'), domain, target,
    expected: z.string().max(1024), wait }),
  z.strictObject({ ...base, type: z.literal('assert_url'), expected: z.url(), wait }),
  z.strictObject({ ...base, type: z.literal('assert_native_selected_option'), domain, target,
    label: z.string().max(512), value: z.string().max(1024), expected: z.boolean(), wait }),
]);
export type SemanticResolvedStepV10 = z.infer<typeof SemanticResolvedStepV10Schema>;
export const SemanticResolvedTestSpecV10Schema = z.strictObject({ schemaVersion: z.literal('10'),
  sourceSchemaVersion: z.literal('7'), sourceContractVersion: z.literal('3'),
  compilerVersion: z.literal('5'), traceVersion: z.literal('semantic_grounded_trace_v1'),
  resolvedSpecId: id, testSpecId: id, compilerAttemptId: id, traceDigest: digest,
  profileFingerprint: digest, executionSteps: z.array(SemanticResolvedStepV10Schema).min(1).max(100),
  resolvedDigest: digest });
export type SemanticResolvedTestSpecV10 = z.infer<typeof SemanticResolvedTestSpecV10Schema>;

const traceRecord = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('navigate'), step: SemanticIntentStepV3Schema,
    observedUrl: z.url() }),
  z.strictObject({ type: z.literal('action'), witness: SemanticGroundingWitnessV1Schema,
    receipt: SemanticActionExecutionReceiptV1Schema }),
  z.strictObject({ type: z.literal('verification'), witness: SemanticGroundingWitnessV1Schema }),
]);
export type SemanticGroundedTraceRecordV1 = z.infer<typeof traceRecord>;
export const SemanticGroundedTraceV1Schema = z.strictObject({
  traceVersion: z.literal('semantic_grounded_trace_v1'), testSpecId: id, attemptId: id,
  sessionId: id, profileFingerprint: digest, admissionDigest: digest,
  records: z.array(traceRecord).min(1).max(100), traceDigest: digest });
export type SemanticGroundedTraceV1 = z.infer<typeof SemanticGroundedTraceV1Schema>;

const issued = new WeakSet<object>();
export function issueSemanticGroundedTraceV1(admission: TrustedSemanticIntentAdmissionV3,
  input: Omit<SemanticGroundedTraceV1, 'traceVersion' | 'testSpecId' | 'admissionDigest' | 'traceDigest'>): SemanticGroundedTraceV1 {
  requireTrustedSemanticIntentAdmissionV3(admission);
  const records = input.records.map((record) => record.type === 'navigate' ? record :
    record.type === 'action' ? { ...record, witness: parseSemanticGroundingWitnessV1(record.witness),
      receipt: parseSemanticActionExecutionReceiptV1(record.receipt) } :
      { ...record, witness: parseSemanticGroundingWitnessV1(record.witness) });
  const data = { traceVersion: 'semantic_grounded_trace_v1' as const,
    testSpecId: admission.spec.testSpecId, attemptId: input.attemptId, sessionId: input.sessionId,
    profileFingerprint: input.profileFingerprint, admissionDigest: admission.record.specDigest, records };
  const trace = parseSemanticGroundedTraceV1({ ...data, traceDigest: hash(data) }, admission);
  issued.add(trace);
  return trace;
}
export function requireIssuedSemanticGroundedTraceV1(trace: SemanticGroundedTraceV1): void {
  if (!issued.has(trace)) throw new Error('UNTRUSTED_SEMANTIC_TRACE');
}
export function parseSemanticGroundedTraceV1(value: unknown,
  admission: TrustedSemanticIntentAdmissionV3): SemanticGroundedTraceV1 {
  requireTrustedSemanticIntentAdmissionV3(admission);
  const trace = SemanticGroundedTraceV1Schema.parse(value);
  const { traceDigest, ...data } = trace;
  if (hash(data) !== traceDigest || trace.testSpecId !== admission.spec.testSpecId ||
      trace.admissionDigest !== admission.record.specDigest ||
      trace.records.length !== admission.spec.steps.length) throw new Error('INVALID_SEMANTIC_TRACE');
  for (let i = 0; i < trace.records.length; i++) {
    const record = trace.records[i]!, step = admission.spec.steps[i]!;
    if (record.type === 'navigate') {
      if (step.type !== 'navigate' || hash(record.step) !== hash(step) ||
          record.observedUrl !== new URL(step.url).href) throw new Error('INVALID_SEMANTIC_TRACE');
      continue;
    }
    const witness = parseSemanticGroundingWitnessV1(record.witness);
    const dependency = step.dependsOnStepId ? trace.records.slice(0, i).find((prior) =>
      prior.type === 'action' && prior.witness.step.id === step.dependsOnStepId) : undefined;
    const dependencyDigest = dependency?.type === 'action' ? dependency.receipt.receiptDigest : null;
    if (hash(witness.step) !== hash(step) || witness.evidence.testSpecId !== trace.testSpecId ||
        witness.evidence.attemptId !== trace.attemptId || witness.evidence.sessionId !== trace.sessionId ||
        witness.evidence.profileFingerprint !== trace.profileFingerprint ||
        Date.parse(witness.evidence.expiresAt) < Date.parse(witness.evidence.observedAt) ||
        witness.evidence.candidates.some((candidate, index) => candidate.domainIndex !== index) ||
        witness.evidence.dependentActionReceiptDigest !== dependencyDigest)
      throw new Error('INVALID_SEMANTIC_TRACE');
    if (record.type === 'action') {
      if (witness.witnessVersion !== 'semantic_action_grounding_v1' ||
          record.receipt.actionWitnessDigest !== witness.witnessDigest ||
          record.receipt.stepId !== step.id || record.receipt.mechanic !== witness.mechanic ||
          record.receipt.beforePageUrl !== witness.evidence.pageUrl ||
          (witness.mechanic === 'click' ?
            record.receipt.effectStatus !== 'delivery_only' || record.receipt.observedFinalState !== null :
            record.receipt.effectStatus !== 'state_proven' ||
            record.receipt.observedFinalState !== (witness.mechanic === 'select_option' ? true :
              witness.mechanic === 'fill' ? witness.argument : witness.requestedChecked)))
        throw new Error('INVALID_SEMANTIC_TRACE');
    } else if (witness.witnessVersion !== 'semantic_verification_grounding_v1')
      throw new Error('INVALID_SEMANTIC_TRACE');
  }
  return trace;
}
export function sealSemanticResolvedTestSpecV10(value: Omit<SemanticResolvedTestSpecV10, 'resolvedDigest' | 'resolvedSpecId'>): SemanticResolvedTestSpecV10 {
  const data = SemanticResolvedTestSpecV10Schema.omit({ resolvedDigest: true }).parse({
    ...value, resolvedSpecId: `semantic-resolved-${randomUUID()}` });
  return SemanticResolvedTestSpecV10Schema.parse({ ...data, resolvedDigest: hash(data) });
}
export function parseSemanticResolvedTestSpecV10(value: unknown, trace: SemanticGroundedTraceV1): SemanticResolvedTestSpecV10 {
  const resolved = SemanticResolvedTestSpecV10Schema.parse(value);
  const { resolvedDigest, ...data } = resolved;
  if (hash(data) !== resolvedDigest || resolved.traceDigest !== trace.traceDigest ||
      resolved.testSpecId !== trace.testSpecId || resolved.profileFingerprint !== trace.profileFingerprint ||
      resolved.executionSteps.length !== trace.records.length ||
      resolved.executionSteps.some((step, index) => {
        const record = trace.records[index]!;
        if (record.type === 'navigate') return record.step.type !== 'navigate' || step.type !== 'navigate' ||
          step.stepId !== record.step.id || step.url !== record.step.url ||
          step.sourceWitnessDigest !== hash(record);
        const witness = record.witness;
        if (step.stepId !== witness.step.id || step.sourceWitnessDigest !== witness.witnessDigest)
          return true;
        const selected = witness.evidence.selectedDomainIndex;
        const candidate = selected === null ? null : witness.evidence.candidates[selected];
        if (step.type !== 'assert_url') {
          const targetIntent = witness.step.type === 'action_intent' ? witness.step.target :
            witness.step.type === 'verification_intent' ? witness.step.subject : null;
          const nativeSelected = witness.step.type === 'verification_intent' &&
            witness.step.observable === 'selected';
          const roles = nativeSelected ? [...new Set(witness.evidence.candidates.map((candidate) =>
            candidate.role))] : semanticResolvedRolesV10(targetIntent,
            witness.evidence.candidates.map((candidate) => candidate.role));
          if (!('domain' in step) || !step.domain.completeRequired ||
              hash(step.domain.roles) !== hash(roles) ||
              step.domain.exactName !== (nativeSelected ? null : targetIntent?.exactName ?? null) ||
              step.domain.context !== (nativeSelected ? null : targetIntent?.context ?? null) ||
              step.domain.groundedCount !== witness.evidence.candidates.length ||
              step.domain.selectedIndex !== selected ||
              step.domain.ordinal !== witness.evidence.ordinalProof?.authoredOrdinal &&
                (step.domain.ordinal !== null || witness.evidence.ordinalProof !== null) ||
              step.domain.orderedIdentities.some((identity, position) =>
                identity !== witness.evidence.candidates[position]?.identity) ||
              step.domain.orderedIdentities.length !== witness.evidence.candidates.length ||
              step.domain.orderedDomPaths.length !== witness.evidence.candidates.length ||
              step.domain.orderedDomPaths.some((path, position) =>
                path !== witness.evidence.candidates[position]?.domPath) ||
              hash(step.domain.relation) !== hash(witness.evidence.relationProof ? {
                kind: witness.evidence.relationProof.kind,
                relatedStepId: witness.evidence.relationProof.relatedStepId,
                selectedIdentity: witness.evidence.relationProof.identity } : null))
            return true;
        }
        if (record.type === 'action') return witness.witnessVersion !== 'semantic_action_grounding_v1' ||
          step.type !== 'action' ||
          step.operation !== witness.mechanic || step.argument !== witness.argument ||
          step.expectedChecked !== witness.requestedChecked ||
          step.target.identity !== candidate?.identity ||
          step.target.domPath !== candidate?.domPath || step.target.role !== candidate?.role ||
          step.target.name !== candidate?.name ||
          step.target.contextProof !== candidate?.contextProof ||
          step.target.exactName !== (witness.step.type === 'action_intent' ?
            witness.step.target.exactName : null) ||
          step.target.context !== (witness.step.type === 'action_intent' ?
            witness.step.target.context : null) ||
          step.domain.requireGroundedCount !== true ||
          (witness.optionProof === null ? step.option !== null :
            step.option?.label !== witness.optionProof.label ||
            step.option?.value !== witness.optionProof.value ||
            step.option?.ownerIdentity !== witness.optionProof.ownerIdentity);
        if (witness.step.type !== 'verification_intent') return true;
        const goal = witness.step;
        if (goal.observable === 'url') return step.type !== 'assert_url' ||
          step.expected !== goal.expected;
        if (goal.observable === 'exists' || goal.observable === 'cardinality')
          return step.type !== 'assert_count' || step.domain.selectedIndex !== null ||
            step.domain.requireGroundedCount !== false ||
            step.operator !== (goal.observable === 'exists' ? goal.expected ? 'at_least' : 'equals' : goal.comparator) ||
            step.expected !== (goal.observable === 'exists' ? goal.expected ? 1 : 0 : goal.expected);
        if (!candidate || !('target' in step) || step.target.identity !== candidate.identity ||
            step.target.domPath !== candidate.domPath || step.target.role !== candidate.role ||
            step.target.name !== candidate.name || step.target.contextProof !== candidate.contextProof ||
            step.target.exactName !== (goal.observable === 'selected' ? null : goal.subject?.exactName ?? null) ||
            step.target.context !== (goal.observable === 'selected' ? null : goal.subject?.context ?? null) ||
            step.domain.requireGroundedCount !== true) return true;
        if (goal.observable === 'selected') {
          const option = candidate.options.find((item) => item.label === goal.subject?.exactName);
          return step.type !== 'assert_native_selected_option' || !option ||
            step.label !== option.label || step.value !== option.value || step.expected !== goal.expected;
        }
        if (goal.observable === 'value') return step.type !== 'assert_value' ||
          step.expected !== goal.expected;
        return step.type !== 'assert_boolean' || step.property !== goal.observable ||
          step.expected !== goal.expected;
      }))
    throw new Error('INVALID_SEMANTIC_RESOLVED_V10');
  return resolved;
}
export const SemanticCompilerAttemptV5Schema = z.strictObject({ compilerVersion: z.literal('5'),
  compilerAttemptId: id, traceDigest: digest, testSpecId: id,
  sourceSessionId: id, freshSessionId: id, profileFingerprint: digest,
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('accepted'), resolvedSpecId: id }),
    z.strictObject({ status: z.literal('rejected'), reason: z.enum(['SOURCE_MISMATCH', 'STALE_EVIDENCE',
      'DOMAIN_MISMATCH', 'TARGET_MISMATCH', 'CAPABILITY_MISMATCH', 'MECHANIC_MISMATCH',
      'OPTION_MISMATCH', 'OBSERVATION_MISMATCH', 'UNSUPPORTED_RELATIONSHIP',
      'ENVIRONMENT_UNAVAILABLE', 'CLEANUP_UNVERIFIED']) }),
  ]), cleanup: z.enum(['verified', 'unverified']), attemptDigest: digest });
export type SemanticCompilerAttemptV5 = z.infer<typeof SemanticCompilerAttemptV5Schema>;
export function sealSemanticCompilerAttemptV5(value: Omit<SemanticCompilerAttemptV5, 'attemptDigest'>): SemanticCompilerAttemptV5 {
  const data = SemanticCompilerAttemptV5Schema.omit({ attemptDigest: true }).parse(value);
  return SemanticCompilerAttemptV5Schema.parse({ ...data, attemptDigest: hash(data) });
}
export function parseSemanticCompilerAttemptV5(value: unknown, trace: SemanticGroundedTraceV1): SemanticCompilerAttemptV5 {
  const attempt = SemanticCompilerAttemptV5Schema.parse(value);
  const { attemptDigest, ...data } = attempt;
  if (hash(data) !== attemptDigest || attempt.traceDigest !== trace.traceDigest ||
      attempt.testSpecId !== trace.testSpecId || attempt.sourceSessionId !== trace.sessionId ||
      attempt.freshSessionId === trace.sessionId || attempt.profileFingerprint !== trace.profileFingerprint)
    throw new Error('INVALID_SEMANTIC_COMPILER_V5');
  return attempt;
}
