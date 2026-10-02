import { z } from 'zod';
import { candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { PreparedActionGroundingV1Schema, parsePreparedActionGroundingV1 } from './action-grounding-strategy.js';
import type { PocSemanticValidationContextV2 } from './action-semantic-admission.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.strictObject({ sessionId: id, pageId: id, frameId: id,
  stateDigest: digest, stateEpoch: z.number().int().nonnegative(), mutationEpoch: z.number().int().nonnegative() });
export const ActionPostEffectV1Schema = z.strictObject({
  postEffectVersion: z.literal('1'), observationId: id, executionId: id, preparedDigest: digest,
  selectedRef: id, sameTargetNode: z.literal(true), complete: z.literal(true),
  before: state, after: state, observedAt: z.iso.datetime(),
  effect: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entered_text'), nativeControl: z.enum(['input', 'textarea']), value: z.string().max(1024) }),
    z.strictObject({ kind: z.literal('native_choice'), value: z.string().max(1024), selectedOptionId: id,
      options: PreparedActionGroundingV1Schema.shape.nativeOptionEvidence.unwrap() }),
    z.strictObject({ kind: z.literal('native_activation'), role: z.enum(['checkbox', 'radio']), nativeInputType: z.enum(['checkbox', 'radio']), beforeChecked: z.boolean(), checked: z.boolean(),
      trustedClickReceipt: z.strictObject({ executionId: id, clicks: z.literal(1), targetOwned: z.literal(true), nativeInputType: z.enum(['checkbox', 'radio']) }) }),
  ]), witnessDigest: digest,
});
export type ActionPostEffectV1 = z.infer<typeof ActionPostEffectV1Schema>;
export const ActionExecutionAttemptV1Schema = z.strictObject({
  executionVersion: z.literal('1'), executionId: id, strategyId: id, preparedDigest: digest,
  admissionDigest: digest, mappingDigest: digest, goalId: id,
  status: z.enum(['rejected', 'failed', 'executed_unproven', 'succeeded']),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(128),
  attempted: z.boolean(), mutationMayHaveOccurred: z.boolean(),
  invocationOutcome: z.enum(['not_invoked', 'returned', 'threw']),
  operation: z.enum(['click', 'fill', 'select_option']), executableArgument: z.string().max(1024).optional(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  invokedAt: z.iso.datetime().optional(), returnedAt: z.iso.datetime().optional(),
  finalCheckDigest: digest.optional(), postEffectDigest: digest.optional(), witnessDigest: digest,
});
export type ActionExecutionAttemptV1 = z.infer<typeof ActionExecutionAttemptV1Schema>;
export function parseActionExecutionAttemptV1(input: unknown): ActionExecutionAttemptV1 {
  const record = ActionExecutionAttemptV1Schema.parse(input), { witnessDigest, ...data } = record;
  if (hash(data) !== witnessDigest || Date.parse(record.finishedAt) < Date.parse(record.startedAt) ||
    record.attempted !== (record.invocationOutcome !== 'not_invoked') || record.mutationMayHaveOccurred !== record.attempted ||
    record.status === 'rejected' !== !record.attempted ||
    record.status === 'failed' && record.invocationOutcome !== 'threw' ||
    ['executed_unproven', 'succeeded'].includes(record.status) && record.invocationOutcome !== 'returned' ||
    record.attempted && (!record.finalCheckDigest || !record.invokedAt) || record.status === 'succeeded' && !record.postEffectDigest ||
    record.status !== 'succeeded' && record.postEffectDigest ||
    record.invocationOutcome === 'returned' && !record.returnedAt || record.invocationOutcome !== 'returned' && record.returnedAt ||
    !record.attempted && record.invokedAt || record.invokedAt && (Date.parse(record.invokedAt) < Date.parse(record.startedAt) || Date.parse(record.invokedAt) > Date.parse(record.finishedAt)) ||
    record.returnedAt && (Date.parse(record.returnedAt) < Date.parse(record.invokedAt!) || Date.parse(record.returnedAt) > Date.parse(record.finishedAt)))
    throw new Error('INVALID_ACTION_EXECUTION');
  return record;
}
export function parseActionPostEffectV1(input: unknown): ActionPostEffectV1 {
  const record = ActionPostEffectV1Schema.parse(input), { witnessDigest, ...data } = record;
  if (hash(data) !== witnessDigest || record.after.sessionId !== record.before.sessionId ||
    record.after.pageId !== record.before.pageId || record.after.frameId !== record.before.frameId ||
    record.after.stateEpoch <= record.before.stateEpoch || record.after.mutationEpoch <= record.before.mutationEpoch)
    throw new Error('INVALID_ACTION_POST_EFFECT');
  if (record.effect.kind === 'native_choice') {
    const effect = record.effect, facts = effect.options, options = facts.options, selected = options.filter((o) => o.selected);
    if (facts.count !== options.length || new Set(options.map((o) => o.optionId)).size !== facts.count ||
      options.some((o, i) => o.index !== i || o.ownerRef !== record.selectedRef || o.ownerFrameId !== record.after.frameId ||
        o.ownerBindingId !== options[0]?.ownerBindingId) ||
      facts.ownerRef !== record.selectedRef || facts.ownerFrameId !== record.after.frameId || selected.length !== 1 ||
      selected[0]!.disabled || selected[0]!.optionId !== record.effect.selectedOptionId || selected[0]!.value !== record.effect.value ||
      options.filter((o) => o.value === effect.value).length !== 1) throw new Error('INVALID_ACTION_POST_EFFECT');
  }
  if (record.effect.kind === 'native_activation' && (record.effect.nativeInputType !== record.effect.role ||
    record.effect.trustedClickReceipt.executionId !== record.executionId || record.effect.trustedClickReceipt.nativeInputType !== record.effect.role ||
    record.effect.role === 'checkbox' && record.effect.checked === record.effect.beforeChecked ||
    record.effect.role === 'radio' && (!record.effect.checked || record.effect.beforeChecked))) throw new Error('INVALID_ACTION_POST_EFFECT');
  return record;
}
export const ActionGroundingWitnessV1Schema = z.strictObject({
  actionGroundingWitnessVersion: z.literal('1'), witnessId: id, status: z.literal('succeeded'),
  preparation: PreparedActionGroundingV1Schema, finalCheck: PreparedActionGroundingV1Schema,
  execution: ActionExecutionAttemptV1Schema, postEffect: ActionPostEffectV1Schema, witnessDigest: digest,
});
export type ActionGroundingWitnessV1 = z.infer<typeof ActionGroundingWitnessV1Schema>;
/** Integrity only. Successful origin requires exact private runtime journal readback. */
export function parseActionGroundingWitnessV1(input: unknown,
  semanticContext?: PocSemanticValidationContextV2): ActionGroundingWitnessV1 {
  const record = ActionGroundingWitnessV1Schema.parse(input), { witnessDigest, ...data } = record;
  const original = parsePreparedActionGroundingV1(record.preparation, semanticContext),
    check = parsePreparedActionGroundingV1(record.finalCheck, semanticContext);
  const execution = parseActionExecutionAttemptV1(record.execution), post = parseActionPostEffectV1(record.postEffect);
  const { witnessDigest: postDigest, ...postData } = post;
  const parent = check.candidateObservation, effect = post.effect;
  if (hash(data) !== witnessDigest || hash(postData) !== postDigest ||
    original.admissionDigest !== check.admissionDigest || original.mappingDigest !== check.mappingDigest ||
    original.goalId !== check.goalId || original.operation !== check.operation ||
    hash(original.correspondence) !== hash(check.correspondence) || original.selectedRef !== check.selectedRef || original.frameId !== check.frameId ||
    hash(original.candidateObservation) !== hash(check.candidateObservation) ||
    execution.status !== 'succeeded' || execution.strategyId !== original.strategyId || execution.preparedDigest !== original.witnessDigest ||
    execution.goalId !== original.goalId || execution.admissionDigest !== original.admissionDigest || execution.mappingDigest !== original.mappingDigest ||
    execution.operation !== check.operation || execution.executableArgument !== check.argument?.executableValue ||
    execution.finalCheckDigest !== check.witnessDigest || execution.postEffectDigest !== post.witnessDigest ||
    post.executionId !== execution.executionId || post.preparedDigest !== check.witnessDigest || post.selectedRef !== check.selectedRef ||
    post.before.sessionId !== parent.sessionId || post.before.pageId !== parent.pageId || post.before.frameId !== check.frameId ||
    post.before.stateDigest !== parent.stateDigest || post.before.stateEpoch !== parent.stateEpoch || post.before.mutationEpoch !== parent.mutationEpoch ||
    post.after.sessionId !== post.before.sessionId || post.after.pageId !== post.before.pageId || post.after.frameId !== post.before.frameId ||
    post.after.stateEpoch <= post.before.stateEpoch || post.after.mutationEpoch <= post.before.mutationEpoch ||
    Date.parse(check.observedAt) < Date.parse(original.observedAt) || Date.parse(check.observedAt) > Date.parse(check.expiresAt) ||
    !execution.invokedAt || !execution.returnedAt || Date.parse(check.observedAt) > Date.parse(execution.invokedAt) ||
    Date.parse(execution.invokedAt) > Date.parse(check.expiresAt) ||
    Date.parse(execution.returnedAt) < Date.parse(execution.invokedAt) ||
    Date.parse(post.observedAt) < Date.parse(execution.returnedAt) || Date.parse(post.observedAt) > Date.parse(execution.finishedAt))
    throw new Error('INVALID_ACTION_GROUNDING_WITNESS');
  if (check.operation === 'fill' && (effect.kind !== 'entered_text' || effect.value !== check.argument?.authoredText) ||
    check.operation === 'select_option' && (effect.kind !== 'native_choice' || effect.value !== check.argument?.executableValue ||
      effect.selectedOptionId !== check.argument.selectedOptionId) ||
    check.operation === 'click' && (effect.kind !== 'native_activation' || effect.nativeInputType !== effect.role ||
      effect.role !== (parent.status === 'complete' ? parent.candidates.find((c) => c.selectedRef === check.selectedRef && c.frameId === check.frameId)?.role : undefined) ||
      effect.role === 'checkbox' && effect.checked === effect.beforeChecked ||
      effect.role === 'radio' && (!effect.checked || effect.beforeChecked))) throw new Error('INVALID_ACTION_GROUNDING_WITNESS');
  if (effect.kind === 'native_choice') {
    const before = check.nativeOptionEvidence!;
    const comparable = (v: typeof before) => v.options.map(({ selected: _selected, ...facts }) => facts);
    const selected = effect.options.options.filter((o) => o.selected);
    if (!before || !effect.options.complete || effect.options.count !== before.count || effect.options.ownerRef !== check.selectedRef ||
      effect.options.ownerFrameId !== check.frameId || hash(comparable(before)) !== hash(comparable(effect.options)) ||
      selected.length !== 1 || selected[0]!.optionId !== effect.selectedOptionId || selected[0]!.value !== effect.value)
      throw new Error('INVALID_ACTION_GROUNDING_WITNESS');
  }
  return record;
}
export type ActionGroundingExecutionOutcomeV1 =
  | { status: 'succeeded'; execution: ActionExecutionAttemptV1; witness: ActionGroundingWitnessV1 }
  | { status: 'stop'; execution: ActionExecutionAttemptV1 };

/** Explicit housekeeping boundary after successful post proof; never an action/effect witness. */
export const ActionGroundingRetirementV1Schema = z.strictObject({ retirementVersion: z.literal('1'),
  witnessId: id, postEffectDigest: digest, before: state, after: state, unchangedMaterial: z.literal(true),
  retiredBinding: z.literal(true), observedAt: z.iso.datetime(), witnessDigest: digest });
export type ActionGroundingRetirementV1 = z.infer<typeof ActionGroundingRetirementV1Schema>;
export function parseActionGroundingRetirementV1(input: unknown): ActionGroundingRetirementV1 {
  const record = ActionGroundingRetirementV1Schema.parse(input), { witnessDigest, ...data } = record;
  if (hash(data) !== witnessDigest || record.before.sessionId !== record.after.sessionId ||
    record.before.pageId !== record.after.pageId || record.before.frameId !== record.after.frameId ||
    record.after.mutationEpoch !== record.before.mutationEpoch + 1 || record.after.stateEpoch !== record.before.stateEpoch + 1 ||
    record.after.stateDigest === record.before.stateDigest)
    throw new Error('INVALID_GROUNDING_RETIREMENT');
  return record;
}
