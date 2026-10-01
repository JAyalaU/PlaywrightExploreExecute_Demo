import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type ActionGoalV2, invalidSource, uniqueIds } from './action-goal-v2.js';
import { parseTestSpecV6V2, type TestSpecV6V2 } from './test-spec-v6-v2.js';
import { ApprovedAbsoluteUrlSchema, ExecutionProfileRefSchema } from './schema.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const TrustedSemanticSourceV2Schema = z.strictObject({
  testSpecId: identifier, sourceInstruction: z.string().min(1).max(16384),
  executionProfileRef: ExecutionProfileRefSchema,
  startState: z.strictObject({ url: z.union([ApprovedAbsoluteUrlSchema, z.literal('about:blank')]) }),
});
export type TrustedSemanticSourceV2 = z.infer<typeof TrustedSemanticSourceV2Schema>;
export const SemanticAdmissionVersionsV2Schema = z.strictObject({
  goalContractVersion: z.literal('2'), primaryExtractionVersion: identifier, independentExtractionVersion: identifier,
  primaryPromptVersion: identifier, independentPromptVersion: identifier,
});
export type SemanticAdmissionVersionsV2 = z.infer<typeof SemanticAdmissionVersionsV2Schema>;
/** Native verification first appears in this reviewed extraction/prompt tuple. Older tuples retain their meaning. */
export const NATIVE_OPTION_ADMISSION_VERSIONS_V2 = Object.freeze({ goalContractVersion: '2' as const,
  primaryExtractionVersion: 'qa_deferred_action_interpretation_v9', independentExtractionVersion: 'qa_deferred_action_source_first_v5',
  primaryPromptVersion: 'action_v2_primary_p5', independentPromptVersion: 'action_v2_source_first_p5' });
const PREVIOUS_CANONICAL_NATIVE_OPTION_ADMISSION_VERSIONS_V2 = Object.freeze({ goalContractVersion: '2' as const,
  primaryExtractionVersion: 'qa_deferred_action_interpretation_v8', independentExtractionVersion: 'qa_deferred_action_source_first_v4',
  primaryPromptVersion: 'action_v2_primary_p4', independentPromptVersion: 'action_v2_source_first_p4' });
const PREVIOUS_OFFSETLESS_NATIVE_OPTION_ADMISSION_VERSIONS_V2 = Object.freeze({ goalContractVersion: '2' as const,
  primaryExtractionVersion: 'qa_deferred_action_interpretation_v7', independentExtractionVersion: 'qa_deferred_action_source_first_v3',
  primaryPromptVersion: 'action_v2_primary_p3', independentPromptVersion: 'action_v2_source_first_p3' });
const PREVIOUS_NATIVE_OPTION_ADMISSION_VERSIONS_V2 = Object.freeze({ goalContractVersion: '2' as const,
  primaryExtractionVersion: 'qa_deferred_action_interpretation_v6', independentExtractionVersion: 'qa_deferred_action_source_first_v2',
  primaryPromptVersion: 'action_v2_primary_p2', independentPromptVersion: 'action_v2_source_first_p2' });
export const SemanticAdmissionRecordV2Schema = z.strictObject({
  admissionVersion: z.literal('2'), sourceDigest: digest, trustedMetadataDigest: digest,
  primaryExtractionDigest: digest, independentExtractionDigest: digest,
  acceptedAccountingObligationDigest: digest, acceptedTestSpecDigest: digest,
  versions: SemanticAdmissionVersionsV2Schema,
});
export type SemanticAdmissionRecordV2 = z.infer<typeof SemanticAdmissionRecordV2Schema>;
export type SemanticAdmissionFailureCode = 'INVALID_SOURCE_REPRESENTATION' | 'SEMANTIC_INTERPRETATION_DISAGREEMENT' |
  'SEMANTIC_FIDELITY_MISMATCH' | 'SEMANTIC_INTERPRETATION_UNRESOLVED' | 'UNSUPPORTED_AUTHORED_OPERATION' | 'UNSUPPORTED_AUTHORED_CONSTRAINT';
export class SemanticAdmissionError extends Error {
  constructor(readonly code: SemanticAdmissionFailureCode) { super(code); this.name = 'SemanticAdmissionError'; }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(Reflect.get(value, key))}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function requireNativeAdmissionVersions(spec: TestSpecV6V2, versions: SemanticAdmissionVersionsV2): void {
  if (spec.steps.some((step) => step.type === 'verification_goal' && 'verificationVersion' in step) &&
      stable(versions) !== stable(NATIVE_OPTION_ADMISSION_VERSIONS_V2) &&
      stable(versions) !== stable(PREVIOUS_CANONICAL_NATIVE_OPTION_ADMISSION_VERSIONS_V2) &&
      stable(versions) !== stable(PREVIOUS_OFFSETLESS_NATIVE_OPTION_ADMISSION_VERSIONS_V2) &&
      stable(versions) !== stable(PREVIOUS_NATIVE_OPTION_ADMISSION_VERSIONS_V2))
    throw new SemanticAdmissionError('INVALID_SOURCE_REPRESENTATION');
}
/** The canonical WP1 preimage; hashing alone never confers admission origin. */
export const semanticAdmissionDigestV2 = hash;
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
const admissionAuthority: unique symbol = Symbol('semantic-admission-v2');
export type TrustedSemanticAdmissionV2 = {
  readonly [admissionAuthority]: true;
  readonly spec: DeepReadonly<TestSpecV6V2>;
  readonly record: DeepReadonly<SemanticAdmissionRecordV2>;
};
const admitted = new WeakSet<object>();

function goalProjection(goal: ActionGoalV2, stepIndices: ReadonlyMap<string, number>): unknown {
  const segments = new Map(goal.sourceAccounting.map((segment) => {
    const { id: _id, obligationIds: _owners, ...source } = segment;
    return [segment.id, source] as const;
  }));
  const anchors = new Map(goal.anchors.map((anchor) => [anchor.id,
    { authoredText: anchor.authoredText, source: anchor.sourceSegmentIds.map((id) => segments.get(id)) }]));
  const obligations = new Map<string, unknown>();
  for (const obligation of goal.obligations) {
    if (obligation.kind === 'contrast') continue;
    const { id: _id, sourceSegmentIds: _refs, ...meaning } = obligation;
    const remapped: Record<string, unknown> = { ...meaning, source: obligation.sourceSegmentIds.map((id) => segments.get(id)) };
    if ('subject' in obligation && obligation.subject.kind === 'anchor')
      remapped.subject = { kind: 'anchor', anchor: anchors.get(obligation.subject.anchorId) };
    if (obligation.kind === 'relationship') { delete remapped.anchorId; remapped.anchor = anchors.get(obligation.anchorId); }
    if (obligation.kind === 'reference') remapped.antecedentStepId = stepIndices.get(obligation.antecedentStepId);
    if (obligation.kind === 'prerequisite') remapped.dependsOnStepId = stepIndices.get(obligation.dependsOnStepId);
    obligations.set(obligation.id, remapped);
  }
  for (const obligation of goal.obligations) {
    if (obligation.kind === 'contrast') obligations.set(obligation.id, {
      kind: obligation.kind, authoredText: obligation.authoredText,
      source: obligation.sourceSegmentIds.map((id) => segments.get(id)),
      endpoints: obligation.obligationIds.map((id) => obligations.get(id)).sort((a, b) => stable(a).localeCompare(stable(b))),
    });
  }
  uniqueIds([...obligations.values()].map(stable), 'DUPLICATE_NORMALIZED_OBLIGATION');
  uniqueIds([...anchors.values()].map(stable), 'DUPLICATE_NORMALIZED_ANCHOR');
  return { type: goal.type, goalVersion: goal.goalVersion, sourceText: goal.sourceText,
    sourceInstructionSpan: goal.sourceInstructionSpan,
    sourceAccounting: goal.sourceAccounting.map((segment) => ({ ...segments.get(segment.id),
      owners: segment.obligationIds.map((id) => obligations.get(id)).sort((a, b) => stable(a).localeCompare(stable(b))) })),
    anchors: [...anchors.values()].sort((a, b) => stable(a).localeCompare(stable(b))),
    obligations: [...obligations.values()].sort((a, b) => stable(a).localeCompare(stable(b))) };
}

/** IDs are local labels. Source occurrence, exact boundaries and semantic ownership are never normalized away. */
export function canonicalSemanticProjectionV2(spec: TestSpecV6V2): unknown {
  const stepIndices = new Map(spec.steps.map((step, index) => [step.id, index]));
  return { schemaVersion: spec.schemaVersion, sourceContractVersion: spec.sourceContractVersion,
    sourceInstruction: spec.sourceInstruction,
    steps: spec.steps.map((step) => {
      if (step.type === 'action_goal') return goalProjection(step, stepIndices);
      const { id: _id, ...meaning } = step;
      return step.type === 'verification_goal' && step.dependsOnStepId ?
        { ...meaning, dependsOnStepId: stepIndices.get(step.dependsOnStepId) } : meaning;
    }),
    instructionAccounting: spec.instructionAccounting.map((segment) => segment.classification === 'clause' ?
      { ...segment, stepId: stepIndices.get(segment.stepId) } : segment) };
}

function validatedExtraction(input: unknown, trustedSource: TrustedSemanticSourceV2): TestSpecV6V2 {
  try {
    const spec = parseTestSpecV6V2(input);
    if (stable({ testSpecId: spec.testSpecId, sourceInstruction: spec.sourceInstruction,
      executionProfileRef: spec.executionProfileRef, startState: spec.startState }) !== stable(trustedSource))
      invalidSource('TRUSTED_SOURCE_OR_METADATA_MISMATCH');
    canonicalSemanticProjectionV2(spec);
    return spec;
  } catch { throw new SemanticAdmissionError('INVALID_SOURCE_REPRESENTATION'); }
}

/** Pure deterministic gate for two already-produced extractions. No provider call or orchestration. */
export function admitActionSemanticsV2(trustedInput: TrustedSemanticSourceV2, primaryInput: unknown,
  independentInput: unknown, versionsInput: SemanticAdmissionVersionsV2): TrustedSemanticAdmissionV2 {
  const trustedSource = TrustedSemanticSourceV2Schema.parse(trustedInput);
  const versions = SemanticAdmissionVersionsV2Schema.parse(versionsInput);
  const primary = validatedExtraction(primaryInput, trustedSource);
  const independent = validatedExtraction(independentInput, trustedSource);
  requireNativeAdmissionVersions(primary, versions);
  requireNativeAdmissionVersions(independent, versions);
  const residual = (spec: TestSpecV6V2) => spec.instructionAccounting.some((segment) => segment.classification === 'unresolved') ||
    spec.steps.some((step) => step.type === 'action_goal' && step.sourceAccounting.some((segment) => segment.classification === 'unresolved'));
  if (residual(primary) || residual(independent)) throw new SemanticAdmissionError('SEMANTIC_INTERPRETATION_UNRESOLVED');
  const primaryProjection = canonicalSemanticProjectionV2(primary);
  const independentProjection = canonicalSemanticProjectionV2(independent);
  if (stable(primaryProjection) !== stable(independentProjection)) {
    const count = (spec: TestSpecV6V2) => spec.steps.reduce((total, step) => total + (step.type === 'action_goal' ? step.obligations.length :
      step.type === 'verification_goal' && 'verificationVersion' in step ? 1 + step.claim.controlConstraints.length : 0), 0);
    throw new SemanticAdmissionError(count(primary) === count(independent) ?
      'SEMANTIC_INTERPRETATION_DISAGREEMENT' : 'SEMANTIC_FIDELITY_MISMATCH');
  }
  if (primary.steps.some((step) => step.type === 'action_goal' && step.obligations.some((item) => item.kind === 'unsupported_operation')))
    throw new SemanticAdmissionError('UNSUPPORTED_AUTHORED_OPERATION');
  if (primary.steps.some((step) => step.type === 'action_goal' && step.obligations.some((item) =>
    item.kind === 'contrast' || 'polarity' in item && item.polarity === 'negative')))
    throw new SemanticAdmissionError('UNSUPPORTED_AUTHORED_CONSTRAINT');
  const record: SemanticAdmissionRecordV2 = {
    admissionVersion: '2', sourceDigest: hash(trustedSource.sourceInstruction),
    trustedMetadataDigest: hash(trustedSource), primaryExtractionDigest: hash(primary), independentExtractionDigest: hash(independent),
    acceptedAccountingObligationDigest: hash(primaryProjection), acceptedTestSpecDigest: hash(primary), versions,
  };
  const admission: TrustedSemanticAdmissionV2 = freeze({ [admissionAuthority]: true as const, spec: primary, record });
  admitted.add(admission);
  // The private WeakSet is the runtime authority; a matching serialized record cannot substitute for it.
  return admission;
}

export function requireTrustedSemanticAdmissionV2(value: TrustedSemanticAdmissionV2): void {
  if (typeof value !== 'object' || value === null || !admitted.has(value)) invalidSource('UNTRUSTED_SEMANTIC_ADMISSION');
}

/** Readback needs an existing trusted admission; storage/digest validity alone grants no authority. */
export function validateSemanticAdmissionReadbackV2(recordInput: unknown, specInput: unknown,
  authority: TrustedSemanticAdmissionV2): TrustedSemanticAdmissionV2 {
  requireTrustedSemanticAdmissionV2(authority);
  const record = SemanticAdmissionRecordV2Schema.parse(recordInput);
  const spec = parseTestSpecV6V2(specInput);
  requireNativeAdmissionVersions(spec, record.versions);
  if (stable(record) !== stable(authority.record) || hash(spec) !== authority.record.acceptedTestSpecDigest)
    invalidSource('SEMANTIC_ADMISSION_READBACK_MISMATCH');
  return authority;
}

/** WP2 must extend this linkage with reviewed mappings and independently endorsed predicates. */
export const ActionObligationHandoffV2Schema = z.strictObject({
  handoffVersion: z.literal('2'), testSpecId: identifier, sourceDigest: digest, admissionDigest: digest,
  acceptedTestSpecDigest: digest, acceptedAccountingObligationDigest: digest,
  goals: z.array(z.strictObject({ goalId: identifier, obligationIds: z.array(identifier).min(1).max(128) })).max(100),
});
export type ActionObligationHandoffV2 = z.infer<typeof ActionObligationHandoffV2Schema>;
export function buildActionObligationHandoffV2(authority: TrustedSemanticAdmissionV2): DeepReadonly<ActionObligationHandoffV2> {
  requireTrustedSemanticAdmissionV2(authority);
  return freeze({ handoffVersion: '2' as const, testSpecId: authority.spec.testSpecId,
    sourceDigest: authority.record.sourceDigest, admissionDigest: hash(authority.record),
    acceptedTestSpecDigest: authority.record.acceptedTestSpecDigest,
    acceptedAccountingObligationDigest: authority.record.acceptedAccountingObligationDigest,
    goals: authority.spec.steps.filter((step) => step.type === 'action_goal').map((goal) => ({
      goalId: goal.id, obligationIds: goal.obligations.map((obligation) => obligation.id),
    })) });
}
export function validateActionObligationHandoffV2(authority: TrustedSemanticAdmissionV2, input: unknown): void {
  requireTrustedSemanticAdmissionV2(authority);
  const handoff = ActionObligationHandoffV2Schema.parse(input);
  if (stable(handoff) !== stable(buildActionObligationHandoffV2(authority))) invalidSource('INCOMPLETE_OR_CHANGED_OBLIGATION_HANDOFF');
}
