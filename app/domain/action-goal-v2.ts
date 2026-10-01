import { z } from 'zod';
import { SourceSpanSchema, sourceSpanText, type SourceSpan } from './action-goal.js';
import { ContractValidationError } from './validate.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const authoredText = z.string().min(1).max(1024);
const references = z.array(identifier).min(1).max(128);
const provenance = { id: identifier, sourceSegmentIds: references };
const endpoint = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('target') }),
  z.strictObject({ kind: z.literal('anchor'), anchorId: identifier }),
]);

/** Authored semantics, never computed browser identities or executable commands. */
export const ActionObligationV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...provenance, kind: z.literal('effect'), effect: z.enum(['activate', 'enter_text', 'choose']) }),
  z.strictObject({ ...provenance, kind: z.literal('operation'), operation: z.enum(['click', 'fill', 'select_option']) }),
  z.strictObject({ ...provenance, kind: z.literal('unsupported_operation') }),
  z.strictObject({ ...provenance, kind: z.literal('argument'), purpose: z.enum(['entered_text', 'choice']), authoredText }),
  z.strictObject({ ...provenance, kind: z.literal('constraint'), constraint: z.enum(['role', 'name', 'context', 'uniqueness']),
    subject: endpoint, polarity: z.enum(['positive', 'negative']), authoredText }),
  z.strictObject({ ...provenance, kind: z.literal('relationship'), subject: z.strictObject({ kind: z.literal('target') }),
    anchorId: identifier, authoredText, polarity: z.enum(['positive', 'negative']) }),
  z.strictObject({ ...provenance, kind: z.literal('prerequisite'), dependsOnStepId: identifier, authoredText }),
  z.strictObject({ ...provenance, kind: z.literal('reference'), antecedentStepId: identifier,
    antecedent: z.enum(['target', 'argument']), authoredText }),
  z.strictObject({ ...provenance, kind: z.literal('contrast'), obligationIds: z.array(identifier).min(2).max(24), authoredText }),
]);
export type ActionObligationV2 = z.infer<typeof ActionObligationV2Schema>;

const segmentBase = { id: identifier, sourceSpan: SourceSpanSchema, authoredText };
export const ActionSourceSegmentV2Schema = z.discriminatedUnion('classification', [
  z.strictObject({ ...segmentBase, classification: z.enum(['effect', 'argument', 'target', 'context', 'relationship', 'prerequisite', 'reference', 'polarity']),
    obligationIds: z.array(identifier).min(1).max(24) }),
  z.strictObject({ ...segmentBase, classification: z.literal('neutral'), obligationIds: z.array(identifier).length(0) }),
  z.strictObject({ ...segmentBase, classification: z.literal('unresolved'), obligationIds: z.array(identifier).length(0),
    reason: z.enum(['unclassified_material', 'unclear_reference', 'unclear_operation', 'authored_alternative']) }),
]);
export type ActionSourceSegmentV2 = z.infer<typeof ActionSourceSegmentV2Schema>;

export const ActionGoalV2Schema = z.strictObject({
  id: identifier, type: z.literal('action_goal'), goalVersion: z.literal('2'), sourceStepId: identifier,
  sourceText: authoredText, sourceInstructionSpan: SourceSpanSchema,
  sourceAccounting: z.array(ActionSourceSegmentV2Schema).min(1).max(256),
  anchors: z.array(z.strictObject({ id: identifier, sourceSegmentIds: references, authoredText })).max(24),
  obligations: z.array(ActionObligationV2Schema).min(1).max(128),
});
export type ActionGoalV2 = z.infer<typeof ActionGoalV2Schema>;

export function invalidSource(reason: string): never {
  throw new ContractValidationError(`INVALID_SOURCE_REPRESENTATION: ${reason}`);
}
export function uniqueIds(values: readonly string[], reason: string): void {
  if (new Set(values).size !== values.length) invalidSource(reason);
}

/** Offsets are UTF-16 string indices. A boundary may not split a surrogate pair. */
export function exactSourceSpan(source: string, span: SourceSpan, expected: string): void {
  const splitPair = (at: number) => at > 0 && at < source.length &&
    source.charCodeAt(at - 1) >= 0xd800 && source.charCodeAt(at - 1) <= 0xdbff &&
    source.charCodeAt(at) >= 0xdc00 && source.charCodeAt(at) <= 0xdfff;
  if (sourceSpanText(source, span) !== expected || splitPair(span.start) || splitPair(span.end))
    invalidSource('SPAN_OR_LITERAL_MISMATCH');
}

const allowedOwners: Record<ActionObligationV2['kind'], readonly ActionSourceSegmentV2['classification'][]> = {
  effect: ['effect'], operation: ['effect'], unsupported_operation: ['effect'], argument: ['argument'],
  constraint: ['target', 'context', 'polarity'], relationship: ['relationship', 'context', 'target', 'polarity'],
  prerequisite: ['prerequisite'], reference: ['reference'], contrast: ['polarity'],
};

/** Mechanical proof only: never interprets ordinary English, role words or connective wording. */
export function validateActionGoalV2(goal: ActionGoalV2, sourceInstruction: string,
  previousSteps: readonly { id: string; type: string; obligations?: readonly ActionObligationV2[] }[] = []): void {
  exactSourceSpan(sourceInstruction, goal.sourceInstructionSpan, goal.sourceText);
  if (goal.sourceStepId !== goal.id) invalidSource('ACTION_LINKAGE_MISMATCH');
  uniqueIds(goal.sourceAccounting.map((segment) => segment.id), 'DUPLICATE_SEGMENT_ID');
  uniqueIds(goal.obligations.map((obligation) => obligation.id), 'DUPLICATE_OBLIGATION_ID');
  uniqueIds(goal.anchors.map((anchor) => anchor.id), 'DUPLICATE_ANCHOR_ID');
  const segments = new Map(goal.sourceAccounting.map((segment) => [segment.id, segment]));
  const obligations = new Map(goal.obligations.map((obligation) => [obligation.id, obligation]));
  const anchors = new Map(goal.anchors.map((anchor) => [anchor.id, anchor]));
  let end = 0;
  for (const segment of goal.sourceAccounting) {
    exactSourceSpan(goal.sourceText, segment.sourceSpan, segment.authoredText);
    if (segment.sourceSpan.start !== end) invalidSource('INCOMPLETE_OR_OVERLAPPING_CLAUSE_PARTITION');
    end = segment.sourceSpan.end;
    uniqueIds(segment.obligationIds, 'DUPLICATE_SEGMENT_OWNER');
    for (const id of segment.obligationIds) {
      const owner = obligations.get(id);
      if (!owner?.sourceSegmentIds.includes(segment.id) || !allowedOwners[owner.kind].includes(segment.classification))
        invalidSource('ILLEGAL_SEGMENT_OWNER');
    }
  }
  if (end !== goal.sourceText.length) invalidSource('INCOMPLETE_CLAUSE_PARTITION');
  const referencedText = (ids: readonly string[], requireContiguous = false): string => {
    uniqueIds(ids, 'DUPLICATE_PROVENANCE_REFERENCE');
    let priorEnd = -1;
    return ids.map((id) => {
      const segment = segments.get(id);
      if (!segment || segment.sourceSpan.start < priorEnd) invalidSource('UNKNOWN_OR_UNORDERED_PROVENANCE');
      // Literal provenance must retain every source byte between its first and last spans.
      if (requireContiguous && priorEnd !== -1 && segment.sourceSpan.start !== priorEnd)
        invalidSource('NONCONTIGUOUS_ARGUMENT_PROVENANCE');
      priorEnd = segment.sourceSpan.end;
      return segment.authoredText;
    }).join('');
  };
  for (const anchor of goal.anchors) {
    if (referencedText(anchor.sourceSegmentIds) !== anchor.authoredText) invalidSource('ANCHOR_NOT_AUTHORED');
    if (anchor.sourceSegmentIds.some((id) => !['target', 'context', 'relationship'].includes(segments.get(id)!.classification)))
      invalidSource('ILLEGAL_ANCHOR_PROVENANCE');
    if (!goal.obligations.some((item) => item.kind === 'relationship' && item.anchorId === anchor.id))
      invalidSource('UNUSED_ANCHOR');
  }
  for (const obligation of goal.obligations) {
    const text = referencedText(obligation.sourceSegmentIds, obligation.kind === 'argument');
    if ('authoredText' in obligation && obligation.authoredText !== text) invalidSource('OBLIGATION_NOT_AUTHORED');
    for (const id of obligation.sourceSegmentIds) {
      if (!segments.get(id)!.obligationIds.includes(obligation.id)) invalidSource('MISSING_RECIPROCAL_OWNERSHIP');
    }
    if (obligation.kind === 'constraint' && obligation.subject.kind === 'anchor' && !anchors.has(obligation.subject.anchorId))
      invalidSource('UNKNOWN_CONSTRAINT_ANCHOR');
    if (obligation.kind === 'relationship' && !anchors.has(obligation.anchorId)) invalidSource('UNKNOWN_RELATIONSHIP_ANCHOR');
    if (obligation.kind === 'constraint' && obligation.subject.kind === 'target' &&
        goal.anchors.some((anchor) => anchor.sourceSegmentIds.some((id) => obligation.sourceSegmentIds.includes(id))))
      invalidSource('TARGET_ANCHOR_OWNERSHIP_OVERLAP');
    if (obligation.kind === 'prerequisite' || obligation.kind === 'reference') {
      const id = obligation.kind === 'prerequisite' ? obligation.dependsOnStepId : obligation.antecedentStepId;
      const prior = previousSteps.find((item) => item.id === id);
      if (!prior || obligation.kind === 'reference' && (prior.type !== 'action_goal' ||
          obligation.antecedent === 'argument' && !prior.obligations?.some((item) => item.kind === 'argument')))
        invalidSource('INVALID_BACKWARD_ACTION_REFERENCE');
    }
    if (obligation.kind === 'contrast') {
      uniqueIds(obligation.obligationIds, 'DUPLICATE_CONTRAST_ENDPOINT');
      if (obligation.obligationIds.some((id) => !obligations.has(id) || obligations.get(id)!.kind !== 'constraint'))
        invalidSource('INVALID_CONTRAST_ENDPOINT');
    }
  }
  const effects = goal.obligations.filter((item) => item.kind === 'effect');
  const arguments_ = goal.obligations.filter((item) => item.kind === 'argument');
  const operations = goal.obligations.filter((item) => item.kind === 'operation' || item.kind === 'unsupported_operation');
  if (effects.length !== 1 || operations.length > 1) invalidSource('EFFECT_OR_OPERATION_CARDINALITY');
  const effect = effects[0]!.effect;
  if (arguments_.length !== (effect === 'activate' ? 0 : 1) || arguments_.some((item) =>
    item.purpose !== (effect === 'choose' ? 'choice' : 'entered_text'))) invalidSource('ARGUMENT_EFFECT_MISMATCH');
  if (operations.some((item) => item.kind === 'operation' && item.operation !==
      (effect === 'activate' ? 'click' : effect === 'enter_text' ? 'fill' : 'select_option')))
    invalidSource('OPERATION_EFFECT_MISMATCH');
  const constraints = goal.obligations.filter((item) => item.kind === 'constraint');
  for (const left of constraints) {
    if (constraints.some((right) => right.id !== left.id && right.constraint === left.constraint &&
      JSON.stringify(right.subject) === JSON.stringify(left.subject) && right.authoredText === left.authoredText &&
      right.polarity !== left.polarity)) invalidSource('CONTRADICTORY_NORMALIZED_CONSTRAINTS');
  }
}
