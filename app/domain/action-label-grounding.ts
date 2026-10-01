import { z } from 'zod';
import { ActionCandidateObservationV1Schema, candidateGroundingDigest as hash,
  parseActionCandidateObservationV1 } from './action-candidate-grounding.js';
import { ActionObligationV2Schema } from './action-goal-v2.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ActionLabelAssociationRequestV1Schema = z.strictObject({
  labelGroundingVersion: z.literal('1'), obligationId: id,
});
export type ActionLabelAssociationRequestV1 = z.infer<typeof ActionLabelAssociationRequestV1Schema>;
const owner = { labelGroundingVersion: z.literal('1'), observationId: id,
  candidateObservation: ActionCandidateObservationV1Schema,
  request: ActionLabelAssociationRequestV1Schema, sourceObligation: ActionObligationV2Schema,
  authoredLabel: z.string().min(1).max(512),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  realizedObligationIds: z.array(id).max(128), pendingObligationIds: z.array(id).max(128), witnessDigest: digest };
const association = z.strictObject({ selectedRef: id, frameId: id,
  accessibleName: z.string().max(512), accessibleNameEqualsAuthoredLabel: z.boolean(),
  exactLabelCorrespondence: z.literal(true),
  sources: z.array(z.strictObject({ sourceId: id, kind: z.enum(['native_label', 'aria_labelledby']),
    ownerRef: id, ownerFrameId: id, nativeOrIdrefOwnership: z.literal(true) })).min(1).max(16) });
export const ActionLabelAssociationObservationV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ ...owner, status: z.literal('complete'), complete: z.literal(true),
    count: z.number().int().min(0).max(80), associations: z.array(association).max(80) }),
  z.strictObject({ ...owner, status: z.literal('error'), complete: z.literal(false),
    reason: z.enum(['RESULT_LIMIT', 'QUERY_UNEVALUABLE', 'STALE_STATE', 'UNSUPPORTED_CONTROL']) }),
]);
export type ActionLabelAssociationObservationV1 = z.infer<typeof ActionLabelAssociationObservationV1Schema>;
export const ActionLabelAssociationBindingV1Schema = z.strictObject({
  labelBindingVersion: z.literal('1'), bindingId: id, observationId: id,
  observationDigest: digest, selectedRef: id, frameId: id, sessionId: id, pageId: id,
  goalId: id, stateDigest: digest, admissionDigest: digest, mappingDigest: digest,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), witnessDigest: digest,
});
export type ActionLabelAssociationBindingV1 = z.infer<typeof ActionLabelAssociationBindingV1Schema>;
/** Association/current-ref facts only. This is not an action or semantic endorsement capability. */
export const ActionLabelAssociationCheckV1Schema = z.strictObject({
  labelCheckVersion: z.literal('1'), checkId: id, binding: ActionLabelAssociationBindingV1Schema,
  parentAssociationObservationId: id, completeAssociationObservation: ActionLabelAssociationObservationV1Schema,
  eligibleAssociationCount: z.literal(1), selectedReferenceMatches: z.literal(true), witnessDigest: digest,
});
export type ActionLabelAssociationCheckV1 = z.infer<typeof ActionLabelAssociationCheckV1Schema>;
export function parseActionLabelAssociationObservationV1(input: unknown): ActionLabelAssociationObservationV1 {
  const record = ActionLabelAssociationObservationV1Schema.parse(input);
  const { witnessDigest, ...data } = record;
  const parent = parseActionCandidateObservationV1(record.candidateObservation);
  const obligation = record.sourceObligation;
  const accounted = [...record.realizedObligationIds, ...record.pendingObligationIds];
  const expectedRealized = [...parent.realizedObligationIds];
  // Exact target designation -> exact associated label is a reviewed mapping. Context is not typed label semantics.
  if (record.status === 'complete' && record.count === 1 && obligation?.kind === 'constraint' && obligation.constraint === 'name' &&
    !expectedRealized.includes(obligation.id)) expectedRealized.push(obligation.id);
  if (hash(data) !== witnessDigest || parent.status !== 'complete' || obligation.id !== record.request.obligationId ||
    !parent.request.handoff.goals.find((g) => g.goalId === parent.goalId)?.obligationIds.includes(obligation.id) ||
    obligation.kind !== 'constraint' || !['name', 'context'].includes(obligation.constraint) ||
    obligation.subject.kind !== 'target' || obligation.polarity !== 'positive' || obligation.authoredText !== record.authoredLabel ||
    Date.parse(record.observedAt) < Date.parse(parent.observedAt) || Date.parse(record.observedAt) > Date.parse(record.expiresAt) ||
    record.expiresAt !== parent.expiresAt || new Set(accounted).size !== accounted.length ||
    accounted.length !== parent.request.mapping.length || parent.request.mapping.some((m) => !accounted.includes(m.obligationId)) ||
    expectedRealized.length !== record.realizedObligationIds.length || expectedRealized.some((i) => !record.realizedObligationIds.includes(i)) ||
    record.status === 'complete' && (record.count !== record.associations.length ||
      new Set(record.associations.map((a) => `${a.frameId}:${a.selectedRef}`)).size !== record.count ||
      record.associations.some((a) => !parent.candidates.some((c) => c.selectedRef === a.selectedRef && c.frameId === a.frameId &&
        c.accessibleName === a.accessibleName) || new Set(a.sources.map((s) => s.sourceId)).size !== a.sources.length ||
        a.sources.some((s) => s.ownerRef !== a.selectedRef || s.ownerFrameId !== a.frameId) ||
        a.accessibleNameEqualsAuthoredLabel !== (a.accessibleName === record.authoredLabel)))) throw new Error('INVALID_LABEL_ASSOCIATION');
  return record;
}
export function parseActionLabelAssociationCheckV1(input: unknown): ActionLabelAssociationCheckV1 {
  const check = ActionLabelAssociationCheckV1Schema.parse(input), { witnessDigest, ...data } = check;
  const observation = parseActionLabelAssociationObservationV1(check.completeAssociationObservation);
  const parent = observation.candidateObservation, binding = check.binding;
  const { witnessDigest: bindingDigest, ...bindingData } = binding;
  if (hash(data) !== witnessDigest || hash(bindingData) !== bindingDigest || observation.status !== 'complete' || observation.count !== 1 ||
    binding.observationId !== check.parentAssociationObservationId || binding.sessionId !== parent.sessionId ||
    binding.pageId !== parent.pageId || binding.goalId !== parent.goalId || binding.stateDigest !== parent.stateDigest ||
    binding.admissionDigest !== parent.admissionDigest || binding.mappingDigest !== parent.mappingDigest || binding.expiresAt !== observation.expiresAt ||
    binding.selectedRef !== observation.associations[0]!.selectedRef || binding.frameId !== observation.associations[0]!.frameId)
    throw new Error('INVALID_LABEL_CHECK');
  return check;
}
