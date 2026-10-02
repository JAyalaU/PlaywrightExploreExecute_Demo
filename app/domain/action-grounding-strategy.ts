import { z } from 'zod';
import { ActionObligationV2Schema, ActionGoalV2Schema, validateActionGoalV2, exactSourceSpan, type ActionGoalV2 } from './action-goal-v2.js';
import { SourceSpanSchema } from './action-goal.js';
import { ActionCandidateRoleV1Schema, ActionCandidateObservationV1Schema, parseActionCandidateObservationV1, candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { buildActionObligationHandoffV2, requirePocSemanticGoalContextV2, requireTrustedSemanticAdmissionV2,
  type PocSemanticValidationContextV2, type TrustedSemanticAdmissionV2 } from './action-semantic-admission.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GroundingRealizationV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['effect', 'operation', 'literal', 'unique', 'pending']) }),
  z.strictObject({ kind: z.enum(['role_exact', 'role_semantic']), role: ActionCandidateRoleV1Schema }),
  z.strictObject({ kind: z.literal('name_exact'), name: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal('label'), text: z.string().min(1).max(512), sourceSegmentIds: z.array(id).min(1).max(128), sourceSpan: SourceSpanSchema.optional() }),
]);
export const GroundingCorrespondenceV1Schema = z.array(z.strictObject({ obligation: ActionObligationV2Schema,
  realization: GroundingRealizationV1Schema })).min(1).max(128);
export type GroundingCorrespondenceV1 = z.infer<typeof GroundingCorrespondenceV1Schema>;
export const ActionGroundingDecisionV5Schema = z.discriminatedUnion('kind', [
  z.strictObject({ decisionVersion: z.literal('5'), kind: z.literal('ground'), goalId: id,
    operation: z.enum(['click', 'fill', 'select_option']), correspondence: GroundingCorrespondenceV1Schema }),
  z.strictObject({ decisionVersion: z.literal('5'), kind: z.literal('stop'), reason: z.enum(['unresolved', 'unsupported']) }),
]);
export type ActionGroundingDecisionV5 = z.infer<typeof ActionGroundingDecisionV5Schema>;
export const IndependentGroundingExtractionV1Schema = z.strictObject({ mappingExtractionVersion: z.literal('1'),
  goalId: id, correspondence: GroundingCorrespondenceV1Schema });

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const issued = new WeakSet<object>();
export interface TrustedGroundingMappingV1 {
  readonly vocabularyVersion: '1';
  readonly primaryPromptVersion: 'wp2d_a_primary_v1';
  readonly independentPromptVersion: 'wp2d_a_independent_v1';
  readonly admission: TrustedSemanticAdmissionV2;
  readonly goalId: string;
  readonly correspondence: GroundingCorrespondenceV1;
  readonly mappingDigest: string;
  readonly independentExtractionDigest?: string;
}
export class GroundingCorrespondenceError extends Error {
  constructor(readonly reason: 'OBLIGATION_MAPPING_MISMATCH' | 'UNSUPPORTED_MAPPING' | 'SEMANTIC_DISAGREEMENT' | 'ENDORSEMENT_REQUIRED') { super(reason); }
}
const fail = (reason: GroundingCorrespondenceError['reason']): never => { throw new GroundingCorrespondenceError(reason); };
const canonical = (entries: GroundingCorrespondenceV1) => hash([...entries].sort((a, b) => a.obligation.id.localeCompare(b.obligation.id)));
export function correspondenceNeedsEndorsement(entries: GroundingCorrespondenceV1): boolean {
  return entries.some(({ obligation: o, realization: r }) => r.kind === 'role_semantic' ||
    r.kind === 'label' && o.kind === 'constraint' && o.constraint === 'context');
}
/** Only source-based independent extraction can endorse inference. Browser facts are absent here. */
export function validateGroundingCorrespondenceV1(admission: TrustedSemanticAdmissionV2, goalId: string, primary: unknown): GroundingCorrespondenceV1 {
  requireTrustedSemanticAdmissionV2(admission);
  const goal = admission.spec.steps.find((s) => s.id === goalId);
  if (!goal || goal.type !== 'action_goal') return fail('OBLIGATION_MAPPING_MISMATCH');
  return validateGoalCorrespondence(goal, primary);
}
function validateGoalCorrespondence(goal: ActionGoalV2 | Extract<TrustedSemanticAdmissionV2['spec']['steps'][number], { type: 'action_goal' }>, primary: unknown): GroundingCorrespondenceV1 {
  const entries = GroundingCorrespondenceV1Schema.parse(primary);
  const effect = goal.obligations.find((o) => o.kind === 'effect');
  const families = { activate: ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'switch', 'treeitem'], enter_text: ['textbox', 'searchbox'], choose: ['combobox', 'listbox'] };
  if (entries.length !== goal.obligations.length || new Set(entries.map((e) => e.obligation.id)).size !== entries.length)
    return fail('OBLIGATION_MAPPING_MISMATCH');
  for (const { obligation: o, realization: r } of entries) {
    if (hash(o) !== hash(goal.obligations.find((v) => v.id === o.id))) return fail('OBLIGATION_MAPPING_MISMATCH');
    let valid = r.kind === 'pending';
    if (r.kind === 'effect' || r.kind === 'operation') valid = o.kind === r.kind;
    if (r.kind === 'literal') valid = o.kind === 'argument';
    if (r.kind === 'unique') valid = o.kind === 'constraint' && o.constraint === 'uniqueness' && o.subject.kind === 'target' && o.polarity === 'positive';
    if (r.kind === 'role_exact' || r.kind === 'role_semantic') valid = o.kind === 'constraint' && o.constraint === 'role' &&
      o.subject.kind === 'target' && o.polarity === 'positive' && effect?.kind === 'effect' && families[effect.effect].includes(r.role) &&
      (r.kind === 'role_semantic' || o.authoredText === r.role);
    if (r.kind === 'name_exact') valid = o.kind === 'constraint' && o.constraint === 'name' && o.subject.kind === 'target' &&
      o.polarity === 'positive' && o.authoredText === r.name;
    if (r.kind === 'label') {
      valid = o.kind === 'constraint' && ['name', 'context'].includes(o.constraint) && o.subject.kind === 'target' && o.polarity === 'positive' &&
        new Set(r.sourceSegmentIds).size === r.sourceSegmentIds.length && r.sourceSegmentIds.every((s) => o.sourceSegmentIds.includes(s));
      const segments = r.sourceSegmentIds.map((s) => goal.sourceAccounting.find((v) => v.id === s));
      valid &&= segments.every((s, i) => !!s && (i === 0 || s.sourceSpan.start >= segments[i - 1]!.sourceSpan.end));
      if (r.sourceSpan) {
        try { exactSourceSpan(goal.sourceText, r.sourceSpan, r.text); } catch { valid = false; }
        let coveredTo = r.sourceSpan.start;
        for (const s of segments) {
          if (!s || s.sourceSpan.end <= coveredTo || s.sourceSpan.start >= r.sourceSpan.end) continue;
          if (s.sourceSpan.start > coveredTo) { valid = false; break; }
          coveredTo = Math.min(r.sourceSpan.end, s.sourceSpan.end);
        }
        valid &&= coveredTo === r.sourceSpan.end;
      } else valid &&= segments.every((s, i) => !!s && (i === 0 || s.sourceSpan.start === segments[i - 1]!.sourceSpan.end)) &&
        segments.map((s) => s?.authoredText).join('') === r.text;
      if (o.kind === 'constraint' && o.constraint === 'name') valid &&= o.authoredText === r.text;
    }
    if (!valid) return fail('UNSUPPORTED_MAPPING');
  }
  return entries;
}
export function admitGroundingMappingV1(admission: TrustedSemanticAdmissionV2, goalId: string, primary: unknown,
  independent?: unknown): TrustedGroundingMappingV1 {
  const entries = validateGroundingCorrespondenceV1(admission, goalId, primary);
  let independentExtractionDigest: string | undefined;
  if (correspondenceNeedsEndorsement(entries)) {
    if (!independent) return fail('ENDORSEMENT_REQUIRED');
    const extracted = IndependentGroundingExtractionV1Schema.parse(independent);
    if (extracted.goalId !== goalId || canonical(extracted.correspondence) !== canonical(entries)) return fail('SEMANTIC_DISAGREEMENT');
    independentExtractionDigest = hash(extracted);
  }
  const versions = { vocabularyVersion: '1' as const, primaryPromptVersion: 'wp2d_a_primary_v1' as const, independentPromptVersion: 'wp2d_a_independent_v1' as const };
  const record = freeze({ ...versions, admission, goalId, correspondence: entries,
    mappingDigest: hash({ versions, handoff: buildActionObligationHandoffV2(admission), goalId, correspondence: entries, independentExtractionDigest }),
    ...(independentExtractionDigest ? { independentExtractionDigest } : {}) });
  issued.add(record); return record;
}
export function requireTrustedGroundingMappingV1(value: TrustedGroundingMappingV1, admission: TrustedSemanticAdmissionV2): void {
  if (!issued.has(value) || value.admission !== admission) fail('OBLIGATION_MAPPING_MISMATCH');
}

export const PreparedActionGroundingV1Schema = z.strictObject({
  strategyVersion: z.literal('1'), status: z.literal('prepared'), executed: z.literal(false), strategyId: id,
  goalId: id, admissionDigest: digest, mappingDigest: digest, correspondence: GroundingCorrespondenceV1Schema,
  sourceGoal: ActionGoalV2Schema, sourceInstruction: z.string().min(1).max(16384),
  vocabularyVersion: z.literal('1'), primaryPromptVersion: z.literal('wp2d_a_primary_v1'), independentPromptVersion: z.literal('wp2d_a_independent_v1'),
  independentExtractionDigest: digest.optional(), candidateObservation: ActionCandidateObservationV1Schema,
  selectedRef: id, frameId: id, operation: z.enum(['click', 'fill', 'select_option']),
  complete: z.literal(true), eligibleCount: z.literal(1), pendingObligationIds: z.array(id).length(0),
  labelEvidence: z.array(z.strictObject({ obligationId: id, text: z.string().min(1).max(512),
    complete: z.literal(true), count: z.number().int().min(0).max(80), associations: z.array(z.strictObject({
      selectedRef: id, frameId: id, sources: z.array(z.strictObject({ sourceId: id, kind: z.enum(['native_label', 'aria_labelledby']),
        ownerRef: id, ownerFrameId: id, nativeOrIdrefOwnership: z.literal(true) })).min(1).max(16),
      accessibleName: z.string().max(512), accessibleNameEqualsAuthoredLabel: z.boolean(), exactLabelCorrespondence: z.literal(true),
    })).max(80) })).max(128),
  nativeOptionEvidence: z.strictObject({ complete: z.literal(true), count: z.number().int().min(0).max(80),
    multiple: z.literal(false), ownerRef: id, ownerFrameId: id,
    options: z.array(z.strictObject({ optionId: id, index: z.number().int().min(0).max(79), ownerBindingId: id,
      ownerRef: id, ownerFrameId: id, displayedLabel: z.string().max(1024), text: z.string().max(1024),
      value: z.string().max(1024), disabled: z.boolean(), selected: z.boolean(), nativeMembership: z.literal(true) })).max(80) }).optional(),
  argument: z.strictObject({ obligationId: id, authoredText: z.string().min(1).max(1024), executableValue: z.string().max(1024),
    kind: z.enum(['entered_text', 'native_choice']), optionCount: z.number().int().min(0).max(80).optional(),
    optionsDigest: digest.optional(), selectedOptionId: id.optional() }).optional(),
  observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), witnessDigest: digest,
});
export type PreparedActionGroundingV1 = z.infer<typeof PreparedActionGroundingV1Schema>;
export function parsePreparedActionGroundingV1(input: unknown,
  semanticContext?: PocSemanticValidationContextV2): PreparedActionGroundingV1 {
  const record = PreparedActionGroundingV1Schema.parse(input), { witnessDigest, ...data } = record;
  const parent = parseActionCandidateObservationV1(record.candidateObservation);
  if (record.sourceGoal.sourceMode === 'semantic_poc')
    requirePocSemanticGoalContextV2(semanticContext, record.sourceGoal, record.sourceInstruction, record.admissionDigest);
  validateActionGoalV2(record.sourceGoal, record.sourceInstruction, [],
    record.sourceGoal.sourceMode === 'semantic_poc' ? { semanticPocSourceValidated: true } : undefined);
  validateGoalCorrespondence(record.sourceGoal, record.correspondence);
  const ids = parent.request.handoff.goals.find((g) => g.goalId === record.goalId)?.obligationIds ?? [];
  const entries = record.correspondence, effect = entries.find((e) => e.obligation.kind === 'effect')?.obligation;
  if (hash(data) !== witnessDigest || record.candidateObservation.status !== 'complete' ||
    record.sourceGoal.id !== record.goalId || hash(record.sourceInstruction) !== parent.request.handoff.sourceDigest ||
    record.sourceGoal.obligations.length !== ids.length ||
    entries.some((e) => hash(e.obligation) !== hash(record.sourceGoal.obligations.find((o) => o.id === e.obligation.id))) ||
    record.goalId !== record.candidateObservation.goalId || record.admissionDigest !== record.candidateObservation.admissionDigest ||
    record.expiresAt !== record.candidateObservation.expiresAt || !record.candidateObservation.candidates.some((c) =>
      c.selectedRef === record.selectedRef && c.frameId === record.frameId) ||
    entries.length !== ids.length || new Set(entries.map((e) => e.obligation.id)).size !== ids.length || entries.some((e) => !ids.includes(e.obligation.id) || e.realization.kind === 'pending') ||
    effect?.kind !== 'effect' || record.operation !== (effect.effect === 'activate' ? 'click' : effect.effect === 'enter_text' ? 'fill' : 'select_option') ||
    entries.some((e) => e.obligation.kind === 'operation' && e.obligation.operation !== record.operation) ||
    correspondenceNeedsEndorsement(entries) && !record.independentExtractionDigest ||
    Date.parse(record.observedAt) < Date.parse(parent.observedAt) || Date.parse(record.observedAt) > Date.parse(record.expiresAt)) throw new Error('INVALID_PREPARED_GROUNDING');
  const versions = { vocabularyVersion: record.vocabularyVersion, primaryPromptVersion: record.primaryPromptVersion, independentPromptVersion: record.independentPromptVersion };
  if (record.mappingDigest !== hash({ versions, handoff: parent.request.handoff, goalId: record.goalId,
    correspondence: record.correspondence, independentExtractionDigest: record.independentExtractionDigest })) throw new Error('INVALID_PREPARED_GROUNDING');
  const key = (ref: string, frame: string) => `${frame}:${ref}`;
  if (parent.status !== 'complete') throw new Error('INVALID_PREPARED_GROUNDING');
  let eligible = parent.candidates;
  for (const e of entries) {
    if (e.realization.kind === 'role_semantic') { const role = e.realization.role; eligible = eligible.filter((c) => c.role === role); }
    if (e.realization.kind !== 'label') continue;
    const text = e.realization.text;
    const evidence = record.labelEvidence.find((l) => l.obligationId === e.obligation.id);
    if (!evidence || evidence.text !== text || evidence.count !== evidence.associations.length ||
      new Set(evidence.associations.map((a) => key(a.selectedRef, a.frameId))).size !== evidence.count ||
      evidence.associations.some((a) => !parent.candidates.some((c) => key(c.selectedRef, c.frameId) === key(a.selectedRef, a.frameId) && c.accessibleName === a.accessibleName) ||
        a.accessibleNameEqualsAuthoredLabel !== (a.accessibleName === evidence.text) || new Set(a.sources.map((s) => s.sourceId)).size !== a.sources.length ||
        a.sources.some((s) => s.ownerRef !== a.selectedRef || s.ownerFrameId !== a.frameId))) throw new Error('INVALID_PREPARED_GROUNDING');
    eligible = eligible.filter((c) => evidence.associations.some((a) => key(a.selectedRef, a.frameId) === key(c.selectedRef, c.frameId)));
  }
  if (record.labelEvidence.length !== entries.filter((e) => e.realization.kind === 'label').length || eligible.length !== 1 ||
    key(eligible[0]!.selectedRef, eligible[0]!.frameId) !== key(record.selectedRef, record.frameId)) throw new Error('INVALID_PREPARED_GROUNDING');
  const sourceArgument = entries.find((e) => e.obligation.kind === 'argument')?.obligation;
  if (sourceArgument?.kind === 'argument') {
    if (!record.argument || record.argument.obligationId !== sourceArgument.id || record.argument.authoredText !== sourceArgument.authoredText ||
      record.argument.kind !== (sourceArgument.purpose === 'choice' ? 'native_choice' : 'entered_text')) throw new Error('INVALID_PREPARED_GROUNDING');
    if (sourceArgument.purpose === 'entered_text' && record.argument.executableValue !== sourceArgument.authoredText) throw new Error('INVALID_PREPARED_GROUNDING');
  } else if (record.argument) throw new Error('INVALID_PREPARED_GROUNDING');
  const options = record.nativeOptionEvidence;
  if (record.operation === 'select_option') {
    if (!options || options.count !== options.options.length || options.ownerRef !== record.selectedRef || options.ownerFrameId !== record.frameId ||
      options.options.some((o, index) => o.index !== index || o.ownerBindingId !== record.strategyId || o.ownerRef !== record.selectedRef || o.ownerFrameId !== record.frameId) ||
      new Set(options.options.map((o) => o.optionId)).size !== options.count || record.argument?.optionsDigest !== hash(options) || record.argument.optionCount !== options.count)
      throw new Error('INVALID_PREPARED_GROUNDING');
    const matches = options.options.filter((o) => o.displayedLabel === record.argument!.authoredText);
    if (matches.length !== 1 || matches[0]!.disabled || matches[0]!.optionId !== record.argument!.selectedOptionId ||
      matches[0]!.value !== record.argument!.executableValue || options.options.filter((o) => o.value === matches[0]!.value).length !== 1) throw new Error('INVALID_PREPARED_GROUNDING');
  } else if (options) throw new Error('INVALID_PREPARED_GROUNDING');
  return record;
}
