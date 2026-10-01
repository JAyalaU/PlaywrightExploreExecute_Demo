import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExecutionProfileRefSchema } from './schema.js';
import { ActionObligationHandoffV2Schema } from './action-semantic-admission.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ActionCandidateRoleV1Schema = z.enum(['button', 'link', 'checkbox', 'radio',
  'menuitem', 'tab', 'option', 'switch', 'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox']);
export type ActionCandidateRoleV1 = z.infer<typeof ActionCandidateRoleV1Schema>;

/** Proposals are data. Every obligation is accounted for, including obligations not yet realizable. */
export const ActionCandidateRequestV1Schema = z.strictObject({
  groundingVersion: z.literal('1'), goalId: id, handoff: ActionObligationHandoffV2Schema,
  mapping: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ obligationId: id, kind: z.literal('effect') }),
    z.strictObject({ obligationId: id, kind: z.literal('operation') }),
    z.strictObject({ obligationId: id, kind: z.literal('literal') }),
    z.strictObject({ obligationId: id, kind: z.literal('role_exact'), role: ActionCandidateRoleV1Schema }),
    z.strictObject({ obligationId: id, kind: z.literal('name_exact'), name: z.string().min(1).max(512) }),
    z.strictObject({ obligationId: id, kind: z.literal('unique') }),
    z.strictObject({ obligationId: id, kind: z.literal('pending') }),
  ])).min(1).max(128),
});
export type ActionCandidateRequestV1 = z.infer<typeof ActionCandidateRequestV1Schema>;
export const ActionCandidatePredicateV1Schema = z.strictObject({
  domain: z.literal('all_current_page_frames'), roles: z.array(ActionCandidateRoleV1Schema).min(1).max(13),
  names: z.array(z.string().min(1).max(512)).max(128),
});
const frame = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('main') }),
  z.strictObject({ kind: z.literal('nested'), anchors: z.array(z.strictObject({
    kind: z.enum(['title', 'testId']), value: z.string().min(1).max(512), exact: z.literal(true),
    ownerDigest: digest, matchCount: z.literal(1),
  })).min(1).max(8) }),
]);
const candidate = z.strictObject({ selectedRef: id, frameId: id, frame,
  role: ActionCandidateRoleV1Schema, accessibleName: z.string().max(512),
  visible: z.boolean(), enabled: z.boolean(), editable: z.boolean(), nativeSelect: z.boolean() });
const owner = {
  groundingVersion: z.literal('1'), observationId: id, testSpecId: id, goalId: id,
  explorationAttemptId: id, sessionId: id, pageId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest,
  stateEpoch: z.number().int().nonnegative(), mutationEpoch: z.number().int().nonnegative(),
  stateDigest: digest, observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  request: ActionCandidateRequestV1Schema, predicate: ActionCandidatePredicateV1Schema,
  admissionDigest: digest, mappingDigest: digest,
  realizedObligationIds: z.array(id).max(128), pendingObligationIds: z.array(id).max(128),
  witnessDigest: digest,
};
export const ActionCandidateObservationV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ ...owner, status: z.literal('complete'), complete: z.literal(true),
    count: z.number().int().min(0).max(80), candidates: z.array(candidate).max(80) }),
  z.strictObject({ ...owner, status: z.literal('error'), complete: z.literal(false),
    reason: z.enum(['RESULT_LIMIT', 'STALE_STATE', 'UNPROVEN_FRAME', 'QUERY_UNEVALUABLE', 'BROWSER_FAILURE']) }),
]);
export type ActionCandidateObservationV1 = z.infer<typeof ActionCandidateObservationV1Schema>;
export const ActionCandidateBindingV1Schema = z.strictObject({
  candidateBindingVersion: z.literal('1'), bindingId: id, observationId: id,
  selectedRef: id, frameId: id, goalId: id, sessionId: id, pageId: id,
  stateDigest: digest, observationDigest: digest, admissionDigest: digest, mappingDigest: digest,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), witnessDigest: digest,
});
export type ActionCandidateBindingV1 = z.infer<typeof ActionCandidateBindingV1Schema>;
/** Successful current checks only: this does not attest execution or post-action effect. */
export const ActionCandidateActionCheckV1Schema = z.strictObject({
  actionCheckVersion: z.literal('1'), checkId: id, bindingId: id, parentObservationId: id,
  operation: z.enum(['click', 'fill', 'select_option']),
  authoredArgument: z.strictObject({ purpose: z.enum(['entered_text', 'choice']), text: z.string().min(1).max(1024) }).optional(),
  completeCandidateObservation: ActionCandidateObservationV1Schema,
  selectedReferenceMatches: z.literal(true), eligibleMatchCount: z.literal(1), witnessDigest: digest,
});
export type ActionCandidateActionCheckV1 = z.infer<typeof ActionCandidateActionCheckV1Schema>;
export function candidateGroundingDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Schema/digest integrity is readback integrity, never runtime issuance authority. */
export function parseActionCandidateObservationV1(input: unknown): ActionCandidateObservationV1 {
  const result = ActionCandidateObservationV1Schema.parse(input);
  const { witnessDigest, ...data } = result;
  const mappingIds = result.request.mapping.map((m) => m.obligationId);
  const accounted = [...result.realizedObligationIds, ...result.pendingObligationIds];
  const goal = result.request.handoff.goals.find((g) => g.goalId === result.goalId);
  const time = Date.parse(result.expiresAt) - Date.parse(result.observedAt);
  if (candidateGroundingDigest(data) !== witnessDigest || result.request.goalId !== result.goalId ||
      result.request.handoff.testSpecId !== result.testSpecId || result.admissionDigest !== result.request.handoff.admissionDigest ||
      result.mappingDigest !== candidateGroundingDigest(result.request.mapping) || !goal ||
      new Set(mappingIds).size !== mappingIds.length || new Set(accounted).size !== accounted.length ||
      mappingIds.length !== accounted.length || mappingIds.some((id) => !accounted.includes(id)) ||
      mappingIds.length !== goal.obligationIds.length || mappingIds.some((id) => !goal.obligationIds.includes(id)) ||
      new Set(result.predicate.roles).size !== result.predicate.roles.length || time < 0 || time > 10_000 ||
      result.status === 'complete' &&
      (result.count !== result.candidates.length || new Set(result.candidates.map((c) =>
        `${c.frameId}:${c.selectedRef}`)).size !== result.count)) throw new Error('INVALID_CANDIDATE_EVIDENCE');
  return result;
}
export function parseActionCandidateActionCheckV1(input: unknown): ActionCandidateActionCheckV1 {
  const check = ActionCandidateActionCheckV1Schema.parse(input);
  const { witnessDigest, ...data } = check;
  const observation = parseActionCandidateObservationV1(check.completeCandidateObservation);
  if (candidateGroundingDigest(data) !== witnessDigest || observation.status !== 'complete' ||
    observation.count !== 1 || observation.pendingObligationIds.length) throw new Error('INVALID_ACTION_CHECK');
  return check;
}
