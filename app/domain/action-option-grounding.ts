import { z } from 'zod';
import { ActionCandidateBindingV1Schema, ActionCandidateObservationV1Schema,
  candidateGroundingDigest, parseActionCandidateObservationV1 } from './action-candidate-grounding.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const option = z.strictObject({ optionId: id, index: z.number().int().min(0).max(79),
  ownerBindingId: id, ownerRef: id, ownerFrameId: id,
  displayedLabel: z.string().max(1024), text: z.string().max(1024), value: z.string().max(1024),
  disabled: z.boolean(), selected: z.boolean(), nativeMembership: z.literal(true) });
const common = { optionGroundingVersion: z.literal('1'), observationId: id,
  candidateObservation: ActionCandidateObservationV1Schema, binding: ActionCandidateBindingV1Schema,
  choiceObligationId: id, authoredChoice: z.string().min(1).max(1024),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), witnessDigest: digest };
export const ActionOptionObservationV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ ...common, status: z.literal('complete'), complete: z.literal(true),
    count: z.number().int().min(0).max(80), multiple: z.boolean(), options: z.array(option).max(80) }),
  z.strictObject({ ...common, status: z.literal('error'), complete: z.literal(false),
    reason: z.enum(['RESULT_LIMIT', 'STALE_STATE', 'QUERY_UNEVALUABLE', 'UNSUPPORTED_CONTROL']) }),
]);
export type ActionOptionObservationV1 = z.infer<typeof ActionOptionObservationV1Schema>;
export const ActionChoiceActionCheckV1Schema = z.strictObject({
  choiceCheckVersion: z.literal('1'), checkId: id, parentOptionObservationId: id,
  completeOptionObservation: ActionOptionObservationV1Schema,
  selectedOptionId: id, executableValue: z.string().max(1024), operation: z.literal('select_option'),
  realizedObligationIds: z.array(id).min(1).max(128), pendingObligationIds: z.array(id).length(0),
  eligibleControlCount: z.literal(1), exactLabelMatchCount: z.literal(1), executableValueMatchCount: z.literal(1),
  witnessDigest: digest,
});
export type ActionChoiceActionCheckV1 = z.infer<typeof ActionChoiceActionCheckV1Schema>;

/** Integrity only; origin authority requires the protected session journal. */
export function parseActionOptionObservationV1(input: unknown): ActionOptionObservationV1 {
  const record = ActionOptionObservationV1Schema.parse(input);
  const { witnessDigest, ...data } = record;
  const candidate = parseActionCandidateObservationV1(record.candidateObservation), binding = record.binding;
  const elapsed = Date.parse(record.expiresAt) - Date.parse(record.observedAt);
  const { witnessDigest: bindingDigest, ...bindingData } = binding;
  const choiceMapping = candidate.request.mapping.find((m) => m.obligationId === record.choiceObligationId);
  if (candidateGroundingDigest(data) !== witnessDigest || candidateGroundingDigest(bindingData) !== bindingDigest ||
    candidate.status !== 'complete' || candidate.count !== 1 ||
    binding.observationId !== candidate.observationId || binding.observationDigest !== candidate.witnessDigest ||
    binding.goalId !== candidate.goalId || binding.sessionId !== candidate.sessionId || binding.pageId !== candidate.pageId ||
    binding.stateDigest !== candidate.stateDigest || binding.admissionDigest !== candidate.admissionDigest ||
    binding.mappingDigest !== candidate.mappingDigest || binding.selectedRef !== candidate.candidates[0]!.selectedRef ||
    binding.frameId !== candidate.candidates[0]!.frameId || choiceMapping?.kind !== 'literal' ||
    !candidate.pendingObligationIds.includes(record.choiceObligationId) || elapsed < 0 || elapsed > 10_000 ||
    Date.parse(binding.issuedAt) < Date.parse(candidate.observedAt) ||
    Date.parse(record.observedAt) < Date.parse(binding.issuedAt) || binding.expiresAt !== candidate.expiresAt ||
    Date.parse(record.expiresAt) > Date.parse(binding.expiresAt) ||
    record.status === 'complete' && (!candidate.candidates[0]!.nativeSelect || record.count !== record.options.length ||
      new Set(record.options.map((o) => o.optionId)).size !== record.count ||
      record.options.some((o, index) => o.index !== index || o.ownerBindingId !== binding.bindingId ||
        o.ownerRef !== binding.selectedRef || o.ownerFrameId !== binding.frameId))) throw new Error('INVALID_OPTION_EVIDENCE');
  return record;
}
export function parseActionChoiceActionCheckV1(input: unknown): ActionChoiceActionCheckV1 {
  const check = ActionChoiceActionCheckV1Schema.parse(input);
  const { witnessDigest, ...data } = check;
  const record = parseActionOptionObservationV1(check.completeOptionObservation);
  if (candidateGroundingDigest(data) !== witnessDigest || record.status !== 'complete') throw new Error('INVALID_CHOICE_CHECK');
  const selected = record.options.find((o) => o.optionId === check.selectedOptionId);
  const ids = record.candidateObservation.request.mapping.map((m) => m.obligationId);
  if (!selected || selected.displayedLabel !== record.authoredChoice || selected.disabled || selected.value !== check.executableValue ||
    record.options.filter((o) => o.displayedLabel === record.authoredChoice).length !== 1 ||
    record.options.filter((o) => o.value === selected.value).length !== 1 ||
    record.candidateObservation.pendingObligationIds.some((id) => id !== record.choiceObligationId) ||
    new Set(check.realizedObligationIds).size !== ids.length || check.realizedObligationIds.length !== ids.length ||
    ids.some((id) => !check.realizedObligationIds.includes(id))) throw new Error('INVALID_CHOICE_CHECK');
  return check;
}
