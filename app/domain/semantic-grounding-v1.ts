import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SemanticIntentStepV3Schema, SemanticTargetIntentV3Schema } from './semantic-intent-v3.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const candidate = z.strictObject({
  frameIndex: z.number().int().nonnegative(), frameUrl: z.string().max(2048),
  domainIndex: z.number().int().nonnegative(), role: z.string().min(1).max(40),
  name: z.string().max(512), exactNameProven: z.boolean(),
  domPath: z.string().max(128), contextProof: z.enum(['none', 'self_category', 'ancestor_text']),
  tag: z.string().min(1).max(40), inputType: z.string().max(40),
  visible: z.boolean(), enabled: z.boolean(), editable: z.boolean(),
  checked: z.boolean().nullable(), value: z.string().max(1024).nullable(),
  nativeSelect: z.boolean(), multiple: z.boolean(),
  options: z.array(z.strictObject({ label: z.string().max(512), value: z.string().max(1024),
    selected: z.boolean(), disabled: z.boolean() })).max(100),
  identity: digest,
});
export type SemanticGroundingCandidateV1 = z.infer<typeof candidate>;
const evidence = z.strictObject({
  evidenceVersion: z.literal('semantic_grounding_evidence_v1'),
  groundingStrategyVersion: z.literal('semantic_capability_discovery_v1'),
  attemptId: id, sessionId: id, testSpecId: id, stepId: id,
  profileFingerprint: digest, pageUrl: z.string().max(2048),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  mcpRevision: z.number().int().nonnegative(),
  dependentActionReceiptDigest: digest.nullable(),
  domainComplete: z.literal(true), target: SemanticTargetIntentV3Schema.nullable(),
  candidates: z.array(candidate).max(100), selectedDomainIndex: z.number().int().nonnegative().nullable(),
  ordinalProof: z.strictObject({ authoredOrdinal: z.number().int().min(1).max(100),
    completeDomainCount: z.number().int().nonnegative(), selectedDomainIndex: z.number().int().nonnegative() }).nullable(),
  relationProof: z.strictObject({ kind: z.enum(['same_as_step', 'created_by_step']),
    relatedStepId: id, identity: digest }).nullable(),
  evidenceDigest: digest,
});
export type SemanticGroundingEvidenceV1 = z.infer<typeof evidence>;
const action = z.strictObject({
  witnessVersion: z.literal('semantic_action_grounding_v1'),
  step: SemanticIntentStepV3Schema,
  evidence,
  mechanic: z.enum(['click', 'check', 'uncheck', 'select_option', 'fill']),
  argument: z.string().max(1024).nullable(),
  currentChecked: z.boolean().nullable(), requestedChecked: z.boolean().nullable(),
  optionProof: z.strictObject({ label: z.string(), value: z.string(),
    ownerIdentity: digest, matchCount: z.literal(1) }).nullable(),
  witnessDigest: digest,
});
const verification = z.strictObject({
  witnessVersion: z.literal('semantic_verification_grounding_v1'),
  step: SemanticIntentStepV3Schema,
  evidence,
  observation: z.enum(['complete_count', 'boolean_property', 'value_property', 'url', 'native_selected_option']),
  property: z.enum(['exists', 'visible', 'enabled', 'checked', 'selected', 'value', 'url', 'cardinality']),
  observed: z.union([z.boolean(), z.number().int().nonnegative(), z.string()]),
  expectedSatisfied: z.boolean(), settled: z.boolean(),
  witnessDigest: digest,
});
export const SemanticGroundingWitnessV1Schema = z.discriminatedUnion('witnessVersion', [action, verification]);
export type SemanticGroundingWitnessV1 = z.infer<typeof SemanticGroundingWitnessV1Schema>;
export type SemanticActionGroundingWitnessV1 = z.infer<typeof action>;
export type SemanticVerificationGroundingWitnessV1 = z.infer<typeof verification>;
export const SemanticActionExecutionReceiptV1Schema = z.strictObject({
  receiptVersion: z.literal('semantic_action_execution_v1'),
  stepId: id, actionWitnessDigest: digest, mechanic: z.enum(['click', 'check', 'uncheck', 'select_option', 'fill']),
  commandReturned: z.literal(true), beforePageUrl: z.string().max(2048), afterPageUrl: z.string().max(2048),
  effectStatus: z.enum(['delivery_only', 'state_proven']),
  observedFinalState: z.union([z.boolean(), z.string().max(1024), z.null()]),
  beforeStateDigest: digest, afterStateDigest: digest, executedAt: z.iso.datetime(), receiptDigest: digest,
});
export type SemanticActionExecutionReceiptV1 = z.infer<typeof SemanticActionExecutionReceiptV1Schema>;

export function semanticGroundingDigestV1(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function sealSemanticGroundingEvidenceV1(value: Omit<SemanticGroundingEvidenceV1, 'evidenceDigest'>): SemanticGroundingEvidenceV1 {
  return evidence.parse({ ...value, evidenceDigest: semanticGroundingDigestV1(value) });
}
export function sealSemanticGroundingWitnessV1<T extends Omit<SemanticGroundingWitnessV1, 'witnessDigest'>>(value: T): SemanticGroundingWitnessV1 {
  return SemanticGroundingWitnessV1Schema.parse({ ...value, witnessDigest: semanticGroundingDigestV1(value) });
}
export function parseSemanticGroundingWitnessV1(value: unknown): SemanticGroundingWitnessV1 {
  const witness = SemanticGroundingWitnessV1Schema.parse(value);
  const { witnessDigest, ...preimage } = witness;
  const { evidenceDigest, ...evidencePreimage } = witness.evidence;
  if (semanticGroundingDigestV1(preimage) !== witnessDigest ||
      semanticGroundingDigestV1(evidencePreimage) !== evidenceDigest ||
      witness.evidence.stepId !== witness.step.id ||
      (witness.witnessVersion === 'semantic_action_grounding_v1' &&
        (witness.step.type !== 'action_intent' || witness.evidence.selectedDomainIndex === null)) ||
      (witness.witnessVersion === 'semantic_verification_grounding_v1' &&
        witness.step.type !== 'verification_intent') ||
      witness.evidence.ordinalProof &&
        (witness.evidence.target?.ordinal !== witness.evidence.ordinalProof.authoredOrdinal ||
          witness.evidence.ordinalProof.completeDomainCount !== witness.evidence.candidates.length ||
          witness.evidence.ordinalProof.selectedDomainIndex !== witness.evidence.selectedDomainIndex) ||
      witness.evidence.selectedDomainIndex !== null &&
      !witness.evidence.candidates.some((c) => c.domainIndex === witness.evidence.selectedDomainIndex))
    throw new Error('INVALID_SEMANTIC_GROUNDING_WITNESS');
  return witness;
}
export function sealSemanticActionExecutionReceiptV1(value: Omit<SemanticActionExecutionReceiptV1, 'receiptDigest'>):
  SemanticActionExecutionReceiptV1 {
  return SemanticActionExecutionReceiptV1Schema.parse({ ...value, receiptDigest: semanticGroundingDigestV1(value) });
}
export function parseSemanticActionExecutionReceiptV1(value: unknown): SemanticActionExecutionReceiptV1 {
  const receipt = SemanticActionExecutionReceiptV1Schema.parse(value);
  const { receiptDigest, ...preimage } = receipt;
  if (semanticGroundingDigestV1(preimage) !== receiptDigest) throw new Error('INVALID_SEMANTIC_ACTION_RECEIPT');
  return receipt;
}
