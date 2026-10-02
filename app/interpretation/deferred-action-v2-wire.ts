import { z } from 'zod';
import { ActionGoalV2Schema, ActionObligationV2Schema, ActionSourceSegmentV2Schema, DeferredAuthoredStepV2Schema,
  LegacyDeferredAuthoredStepV2Schema, InstructionAccountingV2Schema, SourceSpanSchema,
  VerificationGoalSchema } from '../domain/index.js';
import { exactSourceSpan, invalidSource, uniqueIds } from '../domain/action-goal-v2.js';
import { NativeOptionControlConstraintV2Schema, NativeOptionVerificationGoalV2Schema } from '../domain/native-option-verification-goal.js';

export const AUTHORED_AMBIGUITY_V2_CODES = [
  'CONTRADICTORY_AUTHORED_EFFECTS', 'MISSING_LITERAL_ARGUMENT', 'UNRESOLVED_ANTECEDENT',
  'CONFLICTING_EXPLICIT_TARGETS', 'UNCLEAR_AUTHORED_ALTERNATIVES',
] as const;
const evidence = z.array(z.strictObject({ sourceSpan: SourceSpanSchema,
  authoredText: z.string().min(1).max(16384) })).min(1).max(100);
const ambiguity = z.strictObject({ kind: z.literal('authored_ambiguity'),
  reasonCode: z.enum(AUTHORED_AMBIGUITY_V2_CODES), sourceEvidence: evidence });
const unresolved = z.strictObject({ kind: z.literal('unresolved'),
  reasonCode: z.enum(['unclassified_material', 'unclear_reference', 'unclear_operation', 'authored_alternative']),
  sourceEvidence: evidence });

// Provider optionals are required nullable fields; action obligations have no optional fields.
const subject = VerificationGoalSchema.shape.subject.unwrap().shape;
const wireVerification = VerificationGoalSchema.extend({ sourceInstructionSpan: SourceSpanSchema,
  subject: z.strictObject({ role: subject.role.unwrap().nullable(),
    accessibleName: subject.accessibleName.unwrap().nullable(), scope: subject.scope.unwrap().nullable() }).nullable(),
  intent: VerificationGoalSchema.shape.intent.unwrap().nullable(),
  dependsOnStepId: VerificationGoalSchema.shape.dependsOnStepId.unwrap().nullable(),
});
const legacySteps = z.array(z.union([LegacyDeferredAuthoredStepV2Schema.options[0],
  LegacyDeferredAuthoredStepV2Schema.options[1], wireVerification])).min(1).max(100);
const wireNativeVerification = NativeOptionVerificationGoalV2Schema.extend({
  dependsOnStepId: NativeOptionVerificationGoalV2Schema.shape.dependsOnStepId.unwrap().nullable(),
});
const steps = z.array(z.union([LegacyDeferredAuthoredStepV2Schema.options[0],
  LegacyDeferredAuthoredStepV2Schema.options[1], wireVerification, wireNativeVerification])).min(1).max(100);
const instructionAccounting = z.array(InstructionAccountingV2Schema).min(1).max(301);
/** Frozen legacy identities remain separately readable, without native capability. */
export const LegacyPrimaryActionExtractionV2WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: legacySteps, instructionAccounting }), ambiguity, unresolved,
]) });
export const LegacyIndependentActionExtractionV2WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source_extraction'), clauses: legacySteps, instructionAccounting }), ambiguity, unresolved,
]) });
export const PrimaryActionExtractionV2WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps, instructionAccounting }), ambiguity, unresolved,
]) });
export const IndependentActionExtractionV2WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source_extraction'), clauses: steps, instructionAccounting }), ambiguity, unresolved,
]) });

// New provider-only representation: models copy ordered exact text, never UTF-16 offsets.
// The retained V2 wire schemas above remain separately readable, without being accepted by this provider format.
const text = z.string().min(1).max(16384);
const unspannedInstructionAccounting = z.array(z.union([
  InstructionAccountingV2Schema.options[0].omit({ sourceSpan: true }),
  InstructionAccountingV2Schema.options[1].omit({ sourceSpan: true }),
  InstructionAccountingV2Schema.options[2].omit({ sourceSpan: true }),
])).min(1).max(301);
const unspannedActionAccounting = z.array(z.union([
  ActionSourceSegmentV2Schema.options[0].omit({ sourceSpan: true }),
  ActionSourceSegmentV2Schema.options[1].omit({ sourceSpan: true }),
  ActionSourceSegmentV2Schema.options[2].omit({ sourceSpan: true }),
])).min(1).max(256);
export const UnspannedActionGoalV3Schema = ActionGoalV2Schema.omit({ sourceInstructionSpan: true }).extend({
  sourceAccounting: unspannedActionAccounting,
});
const unspannedNavigation = LegacyDeferredAuthoredStepV2Schema.options[0].omit({ sourceInstructionSpan: true });
const unspannedVerification = wireVerification.omit({ sourceInstructionSpan: true });
const claimAccounting = z.array(z.strictObject({
  classification: z.enum(['option', 'control', 'neutral']), authoredText: text,
  controlIndex: z.number().int().nonnegative().max(23).nullable(),
})).min(1).max(100);
export const UnspannedNativeVerificationV3Schema = wireNativeVerification.omit({ sourceInstructionSpan: true }).extend({
  claim: NativeOptionVerificationGoalV2Schema.shape.claim.omit({ optionSourceSpan: true }).extend({
    controlConstraints: z.array(NativeOptionControlConstraintV2Schema.omit({ sourceSpan: true })).max(24),
    claimAccounting,
  }),
});
const unspannedSteps = z.array(z.union([
  unspannedNavigation, UnspannedActionGoalV3Schema, unspannedVerification, UnspannedNativeVerificationV3Schema,
])).min(1).max(100);
const decisionPartition = z.array(z.strictObject({ classification: z.enum(['evidence', 'neutral']), authoredText: text }))
  .min(1).max(301);
const unspannedAmbiguity = z.strictObject({ kind: z.literal('authored_ambiguity'),
  reasonCode: z.enum(AUTHORED_AMBIGUITY_V2_CODES), sourcePartition: decisionPartition });
const unspannedUnresolved = z.strictObject({ kind: z.literal('unresolved'),
  reasonCode: z.enum(['unclassified_material', 'unclear_reference', 'unclear_operation', 'authored_alternative']),
  sourcePartition: decisionPartition });
/** New closed provider identities, not an in-place reinterpretation of the V2 wire readers. */
export const PrimaryActionExtractionV3WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: unspannedSteps,
    instructionAccounting: unspannedInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });
export const IndependentActionExtractionV3WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source_extraction'), clauses: unspannedSteps,
    instructionAccounting: unspannedInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });

// Successor provider representation: semantic graph and exact source partitions remain model-authored;
// duplicated source strings are reconstructed from those partitions and checked by the canonical validators.
const untextedObligations = z.array(z.union([
  ActionObligationV2Schema.options[0], ActionObligationV2Schema.options[1], ActionObligationV2Schema.options[2],
  ActionObligationV2Schema.options[3].omit({ authoredText: true }),
  ActionObligationV2Schema.options[4].omit({ authoredText: true }),
  ActionObligationV2Schema.options[5].omit({ authoredText: true }),
  ActionObligationV2Schema.options[6].omit({ authoredText: true }),
  ActionObligationV2Schema.options[7].omit({ authoredText: true }),
  ActionObligationV2Schema.options[8].omit({ authoredText: true }),
])).min(1).max(128);
export const UnspannedActionGoalV4Schema = ActionGoalV2Schema.omit({ sourceInstructionSpan: true, sourceText: true }).extend({
  sourceAccounting: unspannedActionAccounting,
  anchors: z.array(ActionGoalV2Schema.shape.anchors.element.omit({ authoredText: true })).max(24),
  obligations: untextedObligations,
});
const untextedNavigation = unspannedNavigation.omit({ sourceText: true });
const untextedVerification = unspannedVerification.omit({ sourceText: true, instruction: true });
export const UnspannedNativeVerificationV4Schema = UnspannedNativeVerificationV3Schema.omit({ sourceText: true,
  instruction: true }).extend({
  claim: UnspannedNativeVerificationV3Schema.shape.claim.omit({ optionLabel: true }).extend({
    controlConstraints: z.array(NativeOptionControlConstraintV2Schema.omit({ sourceSpan: true, text: true })).max(24),
  }),
});
const untextedSteps = z.array(z.union([
  untextedNavigation, UnspannedActionGoalV4Schema, untextedVerification, UnspannedNativeVerificationV4Schema,
])).min(1).max(100);
export const PrimaryActionExtractionV4WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: untextedSteps,
    instructionAccounting: unspannedInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });
export const IndependentActionExtractionV4WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source_extraction'), clauses: untextedSteps,
    instructionAccounting: unspannedInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });

// Next provider boundary keeps only forward graph choices. Reverse ownership and ordered clause
// linkage are deterministic projections of those choices, not independent model judgements.
const forwardInstructionAccounting = z.array(z.union([
  InstructionAccountingV2Schema.options[0].omit({ sourceSpan: true, stepId: true }),
  InstructionAccountingV2Schema.options[1].omit({ sourceSpan: true }),
  InstructionAccountingV2Schema.options[2].omit({ sourceSpan: true }),
])).min(1).max(301);
const forwardActionAccounting = z.array(z.union([
  ActionSourceSegmentV2Schema.options[0].omit({ sourceSpan: true, obligationIds: true }),
  ActionSourceSegmentV2Schema.options[1].omit({ sourceSpan: true, obligationIds: true }),
  ActionSourceSegmentV2Schema.options[2].omit({ sourceSpan: true, obligationIds: true }),
])).min(1).max(256);
export const ForwardActionGoalV5Schema = UnspannedActionGoalV4Schema.omit({ sourceStepId: true }).extend({
  sourceAccounting: forwardActionAccounting,
});
const forwardSteps = z.array(z.union([
  untextedNavigation, ForwardActionGoalV5Schema, untextedVerification, UnspannedNativeVerificationV4Schema,
])).min(1).max(100);
export const PrimaryActionExtractionV5WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: forwardSteps,
    instructionAccounting: forwardInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });
export const IndependentActionExtractionV5WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source_extraction'), clauses: forwardSteps,
    instructionAccounting: forwardInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });

// One exact clause copy lives at the step boundary, never again in instructionAccounting.
const singleSourceSteps = z.array(z.union([
  unspannedNavigation, ForwardActionGoalV5Schema,
  unspannedVerification.omit({ instruction: true }), UnspannedNativeVerificationV4Schema,
])).min(1).max(100);
const classifiedInstructionAccounting = z.array(z.discriminatedUnion('classification', [
  z.strictObject({ classification: z.literal('clause') }),
  z.strictObject({ classification: z.literal('neutral'), authoredText: text }),
  z.strictObject({ classification: z.literal('unresolved'), authoredText: text,
    reason: z.enum(['unclassified_material', 'unclear_clause_linkage', 'authored_alternative']) }),
])).min(1).max(301);
export const PrimaryActionExtractionV6WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'), steps: singleSourceSteps,
    instructionAccounting: classifiedInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });
export const IndependentActionExtractionV6WireSchema = z.strictObject({ response: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source_extraction'), clauses: singleSourceSteps,
    instructionAccounting: classifiedInstructionAccounting }), unspannedAmbiguity, unspannedUnresolved,
]) });

function format(name: string, schema: z.ZodType) {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  // Zod discriminated unions are pairwise disjoint by kind/classification, so anyOf is
  // equivalent here and supported by Structured Outputs. Runtime Zod remains authoritative.
  const providerSchema = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(providerSchema);
    if (value === null || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(node).flatMap(([key, child]) => {
      // PoC-only internal marker is never requested from historical provider formats.
      if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child))
        return [[key, providerSchema(Object.fromEntries(Object.entries(child).filter(([field]) => field !== 'sourceMode')))]];
      if (key === 'format' && child === 'uri') return []; // URL policy is enforced locally.
      if (key === 'const') return [['enum', [child]]];
      if (key === 'exclusiveMinimum' && node.type === 'integer' && typeof child === 'number') return [['minimum', child + 1]];
      return [[key === 'oneOf' ? 'anyOf' : key, providerSchema(child)]];
    }));
  };
  return Object.freeze({ type: 'json_schema' as const, name, strict: true as const, schema: providerSchema(jsonSchema) });
}
/** New identities; neither replaces the stored ActionGoal v1 format. */
export const LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_action_interpretation_v5', LegacyPrimaryActionExtractionV2WireSchema);
export const LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT = format('qa_deferred_action_source_first_v1', LegacyIndependentActionExtractionV2WireSchema);
export const PREVIOUS_ACTION_V2_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_action_interpretation_v6', PrimaryActionExtractionV2WireSchema);
export const PREVIOUS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT = format('qa_deferred_action_source_first_v2', IndependentActionExtractionV2WireSchema);
export const PREVIOUS_OFFSETLESS_ACTION_V2_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_action_interpretation_v7', PrimaryActionExtractionV3WireSchema);
export const PREVIOUS_OFFSETLESS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT = format('qa_deferred_action_source_first_v3', IndependentActionExtractionV3WireSchema);
export const PREVIOUS_CANONICAL_ACTION_V2_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_action_interpretation_v8', PrimaryActionExtractionV4WireSchema);
export const PREVIOUS_CANONICAL_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT = format('qa_deferred_action_source_first_v4', IndependentActionExtractionV4WireSchema);
export const PREVIOUS_FORWARD_ACTION_V2_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_action_interpretation_v9', PrimaryActionExtractionV5WireSchema);
export const PREVIOUS_FORWARD_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT = format('qa_deferred_action_source_first_v5', IndependentActionExtractionV5WireSchema);
export const ACTION_V2_PRIMARY_RESPONSE_FORMAT = format('qa_deferred_action_interpretation_v10', PrimaryActionExtractionV6WireSchema);
export const ACTION_V2_INDEPENDENT_RESPONSE_FORMAT = format('qa_deferred_action_source_first_v6', IndependentActionExtractionV6WireSchema);

function normalizeSteps(input: z.infer<typeof steps>) {
  return input.map((step) => {
    if (step.type !== 'verification_goal') return step;
    if ('verificationVersion' in step) {
      const { dependsOnStepId, ...rest } = step;
      return { ...rest, ...(dependsOnStepId === null ? {} : { dependsOnStepId }) };
    }
    const { subject: rawSubject, intent, dependsOnStepId, ...rest } = step;
    const normalizedSubject = rawSubject === null ? undefined : {
      ...(rawSubject.role === null ? {} : { role: rawSubject.role }),
      ...(rawSubject.accessibleName === null ? {} : { accessibleName: rawSubject.accessibleName }),
      ...(rawSubject.scope === null ? {} : { scope: rawSubject.scope }),
    };
    return { ...rest, ...(normalizedSubject && Object.keys(normalizedSubject).length ? { subject: normalizedSubject } : {}),
      ...(intent === null ? {} : { intent }), ...(dependsOnStepId === null ? {} : { dependsOnStepId }) };
  });
}
export function normalizePrimaryActionExtractionV2Wire(input: unknown): string {
  const { response } = PrimaryActionExtractionV2WireSchema.parse(input);
  return JSON.stringify(response.kind === 'extraction' ? { ...response, steps: normalizeSteps(response.steps) } : response);
}
export function normalizeIndependentActionExtractionV2Wire(input: unknown): string {
  const { response } = IndependentActionExtractionV2WireSchema.parse(input);
  return JSON.stringify(response.kind === 'source_extraction' ? { kind: 'extraction',
    steps: normalizeSteps(response.clauses), instructionAccounting: response.instructionAccounting } : response);
}

/** Exact ordered reconstruction; no search, trimming, case-folding, or model-authored offset authority. */
function partition(source: string, segments: readonly { authoredText: string }[]) {
  let cursor = 0;
  const spans = segments.map((segment) => {
    const span = { start: cursor, end: cursor + segment.authoredText.length };
    exactSourceSpan(source, span, segment.authoredText);
    cursor = span.end;
    return span;
  });
  if (cursor !== source.length) invalidSource('INCOMPLETE_ORDERED_SOURCE_RECONSTRUCTION');
  return spans;
}

/** List syntax at the start of an authored line is source framing, not model-owned clause text. */
function listFraming(source: string): { start: number; authoredText: string }[] {
  const markers: { start: number; authoredText: string }[] = [];
  let lineStart = 0;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? source.length : lineEnd;
    const line = source.slice(lineStart, end);
    const marker = /^[ \t]*(?:\d+[.)]|\(\d+\)|[-*•])[ \t]+/u.exec(line)?.[0];
    if (marker && line.slice(marker.length).trim()) markers.push({ start: lineStart, authoredText: marker });
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return markers;
}

/** Provider segments must account for every non-framing byte; they cannot absorb or repair a marker. */
function trustedFramedInstructionAccounting(source: string,
  segments: z.infer<typeof forwardInstructionAccounting>): z.infer<typeof forwardInstructionAccounting> {
  const markers = listFraming(source);
  const accounted: z.infer<typeof forwardInstructionAccounting> = [];
  let cursor = 0, markerIndex = 0;
  const insertMarker = () => {
    const marker = markers[markerIndex]!;
    if (marker.start !== cursor) return false;
    exactSourceSpan(source, { start: cursor, end: cursor + marker.authoredText.length }, marker.authoredText);
    accounted.push({ classification: 'neutral', authoredText: marker.authoredText });
    cursor += marker.authoredText.length;
    markerIndex++;
    return true;
  };
  for (const segment of segments) {
    while (markerIndex < markers.length && insertMarker()) { /* Trusted framing before this segment. */ }
    const end = cursor + segment.authoredText.length;
    if (markerIndex < markers.length && markers[markerIndex]!.start < end)
      invalidSource('SPAN_OR_LITERAL_MISMATCH');
    exactSourceSpan(source, { start: cursor, end }, segment.authoredText);
    accounted.push(segment);
    cursor = end;
  }
  while (markerIndex < markers.length && insertMarker()) { /* Trusted trailing framing. */ }
  if (cursor !== source.length || markerIndex !== markers.length)
    invalidSource('INCOMPLETE_ORDERED_SOURCE_RECONSTRUCTION');
  return accounted;
}

/** A line break immediately before a recognized list marker is trusted list framing too. */
function listAndLineFraming(source: string): { start: number; authoredText: string }[] {
  return listFraming(source).flatMap((marker) => {
    const newlineEnd = marker.start;
    if (newlineEnd === 0 || source[newlineEnd - 1] !== '\n') return [marker];
    const newlineStart = source[newlineEnd - 2] === '\r' ? newlineEnd - 2 : newlineEnd - 1;
    return [{ start: newlineStart, authoredText: source.slice(newlineStart, newlineEnd) }, marker];
  });
}

/** Sequential exact reconstruction from one step clause copy plus any non-clause gaps. */
function trustedClassifiedInstructionAccounting(source: string, stepsInput: z.infer<typeof singleSourceSteps>,
  segments: z.infer<typeof classifiedInstructionAccounting>): z.infer<typeof forwardInstructionAccounting> {
  const markers = listAndLineFraming(source);
  const accounted: z.infer<typeof forwardInstructionAccounting> = [];
  let cursor = 0, markerIndex = 0, clauseIndex = 0;
  const insertMarkers = () => {
    while (markerIndex < markers.length && markers[markerIndex]!.start === cursor) {
      const marker = markers[markerIndex++]!;
      exactSourceSpan(source, { start: cursor, end: cursor + marker.authoredText.length }, marker.authoredText);
      accounted.push({ classification: 'neutral', authoredText: marker.authoredText });
      cursor += marker.authoredText.length;
    }
  };
  for (const segment of segments) {
    insertMarkers();
    let authoredText: string;
    if (segment.classification === 'clause') {
      const step = stepsInput[clauseIndex++];
      if (!step) invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
      authoredText = step.type === 'action_goal' ? step.sourceAccounting.map((item) => item.authoredText).join('') :
        step.type === 'verification_goal' && 'verificationVersion' in step ?
          step.claim.claimAccounting.map((item) => item.authoredText).join('') : step.sourceText;
    } else authoredText = segment.authoredText;
    const end = cursor + authoredText.length;
    if (end <= cursor || end > source.length ||
        markerIndex < markers.length && markers[markerIndex]!.start < end)
      invalidSource('SPAN_OR_LITERAL_MISMATCH');
    exactSourceSpan(source, { start: cursor, end }, authoredText);
    accounted.push({ ...segment, authoredText });
    cursor = end;
  }
  insertMarkers();
  if (cursor !== source.length || markerIndex !== markers.length || clauseIndex !== stepsInput.length)
    invalidSource('INCOMPLETE_ORDERED_SOURCE_RECONSTRUCTION');
  return accounted;
}

function normalizeUnspannedExtraction(source: string, input: {
  steps: z.infer<typeof unspannedSteps>; instructionAccounting: z.infer<typeof unspannedInstructionAccounting>;
}): string {
  const instructionSpans = partition(source, input.instructionAccounting);
  const instructionAccounting = input.instructionAccounting.map((segment, i) =>
    ({ ...segment, sourceSpan: instructionSpans[i]! }));
  const clauses = instructionAccounting.filter((item) => item.classification === 'clause');
  if (clauses.length !== input.steps.length) invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
  const derived = input.steps.map((step, index) => {
    const clause = clauses[index]!;
    if (clause.classification !== 'clause' || clause.stepId !== step.id || clause.authoredText !== step.sourceText)
      invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
    const sourceInstructionSpan = clause.sourceSpan;
    if (step.type === 'action_goal') {
      const segmentSpans = partition(step.sourceText, step.sourceAccounting);
      return { ...step, sourceInstructionSpan, sourceAccounting: step.sourceAccounting.map((segment, i) =>
        ({ ...segment, sourceSpan: segmentSpans[i]! })) };
    }
    if (step.type === 'verification_goal' && 'verificationVersion' in step) {
      const claimSpans = partition(step.sourceText, step.claim.claimAccounting);
      let optionSourceSpan: { start: number; end: number } | undefined;
      const controlSpans = new Map<number, { start: number; end: number }>();
      for (const [i, segment] of step.claim.claimAccounting.entries()) {
        if (segment.classification === 'option') {
          if (segment.controlIndex !== null || segment.authoredText !== step.claim.optionLabel || optionSourceSpan)
            invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
          optionSourceSpan = claimSpans[i]!;
        } else if (segment.classification === 'control') {
          const index = segment.controlIndex;
          if (index === null || index >= step.claim.controlConstraints.length || controlSpans.has(index) ||
              segment.authoredText !== step.claim.controlConstraints[index]!.text)
            invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
          controlSpans.set(index, claimSpans[i]!);
        } else if (segment.controlIndex !== null) invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
      }
      if (!optionSourceSpan || controlSpans.size !== step.claim.controlConstraints.length)
        invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
      const { claimAccounting: _accounting, ...claim } = step.claim;
      return { ...step, sourceInstructionSpan, claim: { ...claim, optionSourceSpan,
        controlConstraints: claim.controlConstraints.map((constraint, i) =>
          ({ ...constraint, sourceSpan: controlSpans.get(i)! })) } };
    }
    return { ...step, sourceInstructionSpan };
  });
  const normalized = { kind: 'extraction' as const, steps: normalizeSteps(steps.parse(derived)),
    instructionAccounting: instructionAccountingSchema.parse(instructionAccounting) };
  return JSON.stringify(ActionExtractionV2ResponseSchema.parse(normalized));
}

const instructionAccountingSchema = z.array(InstructionAccountingV2Schema).min(1).max(301);
function normalizeUnspannedDecision(source: string, response: z.infer<typeof unspannedAmbiguity> |
  z.infer<typeof unspannedUnresolved>): string {
  const spans = partition(source, response.sourcePartition);
  const sourceEvidence = response.sourcePartition.flatMap((segment, index) => segment.classification === 'evidence' ?
    [{ sourceSpan: spans[index]!, authoredText: segment.authoredText }] : []);
  const { sourcePartition: _partition, ...decision } = response;
  return JSON.stringify(ActionExtractionV2ResponseSchema.parse({ ...decision, sourceEvidence }));
}

export function normalizePrimaryActionExtractionV3Wire(input: unknown, trustedSource: string): string {
  const { response } = PrimaryActionExtractionV3WireSchema.parse(input);
  return response.kind === 'extraction' ? normalizeUnspannedExtraction(trustedSource, response) :
    normalizeUnspannedDecision(trustedSource, response);
}
export function normalizeIndependentActionExtractionV3Wire(input: unknown, trustedSource: string): string {
  const { response } = IndependentActionExtractionV3WireSchema.parse(input);
  return response.kind === 'source_extraction' ? normalizeUnspannedExtraction(trustedSource,
    { steps: response.clauses, instructionAccounting: response.instructionAccounting }) :
    normalizeUnspannedDecision(trustedSource, response);
}

/** A reference contributes only its exact accounted segment text; it cannot supply or repair characters. */
function referencedSourceText(ids: readonly string[], segments: ReadonlyMap<string, {
  authoredText: string; sourceSpan: { start: number; end: number };
}>, contiguous: boolean): string {
  uniqueIds(ids, 'DUPLICATE_PROVENANCE_REFERENCE');
  let priorEnd = -1;
  return ids.map((id) => {
    const segment = segments.get(id);
    if (!segment || segment.sourceSpan.start < priorEnd) invalidSource('UNKNOWN_OR_UNORDERED_PROVENANCE');
    if (contiguous && priorEnd !== -1 && segment.sourceSpan.start !== priorEnd)
      invalidSource('NONCONTIGUOUS_ARGUMENT_PROVENANCE');
    priorEnd = segment.sourceSpan.end;
    return segment.authoredText;
  }).join('');
}

function normalizeUntextedExtraction(source: string, input: {
  steps: z.infer<typeof untextedSteps>; instructionAccounting: z.infer<typeof unspannedInstructionAccounting>;
}): string {
  const instructionSpans = partition(source, input.instructionAccounting);
  const instructionAccounting = input.instructionAccounting.map((segment, i) =>
    ({ ...segment, sourceSpan: instructionSpans[i]! }));
  const clauses = instructionAccounting.filter((item) => item.classification === 'clause');
  if (clauses.length !== input.steps.length) invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
  const derived = input.steps.map((step, index) => {
    const clause = clauses[index]!;
    if (clause.classification !== 'clause' || clause.stepId !== step.id)
      invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
    const sourceText = clause.authoredText, sourceInstructionSpan = clause.sourceSpan;
    if (step.type === 'action_goal') {
      const segmentSpans = partition(sourceText, step.sourceAccounting);
      const sourceAccounting = step.sourceAccounting.map((segment, i) =>
        ({ ...segment, sourceSpan: segmentSpans[i]! }));
      uniqueIds(sourceAccounting.map((segment) => segment.id), 'DUPLICATE_SEGMENT_ID');
      const segments = new Map(sourceAccounting.map((segment) => [segment.id, segment]));
      const anchors = step.anchors.map((anchor) => ({ ...anchor,
        authoredText: referencedSourceText(anchor.sourceSegmentIds, segments, false) }));
      const obligations = step.obligations.map((obligation) =>
        obligation.kind === 'effect' || obligation.kind === 'operation' || obligation.kind === 'unsupported_operation' ?
          obligation : { ...obligation, authoredText: referencedSourceText(obligation.sourceSegmentIds, segments,
            obligation.kind === 'argument') });
      return { ...step, sourceText, sourceInstructionSpan, sourceAccounting, anchors, obligations };
    }
    if (step.type === 'verification_goal' && 'verificationVersion' in step) {
      const claimSpans = partition(sourceText, step.claim.claimAccounting);
      let optionSourceSpan: { start: number; end: number } | undefined, optionLabel: string | undefined;
      const controls = new Map<number, { sourceSpan: { start: number; end: number }; text: string }>();
      for (const [i, segment] of step.claim.claimAccounting.entries()) {
        if (segment.classification === 'option') {
          if (segment.controlIndex !== null || optionSourceSpan) invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
          optionSourceSpan = claimSpans[i]!; optionLabel = segment.authoredText;
        } else if (segment.classification === 'control') {
          const controlIndex = segment.controlIndex;
          if (controlIndex === null || controlIndex >= step.claim.controlConstraints.length || controls.has(controlIndex))
            invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
          controls.set(controlIndex, { sourceSpan: claimSpans[i]!, text: segment.authoredText });
        } else if (segment.controlIndex !== null) invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
      }
      if (!optionSourceSpan || !optionLabel || controls.size !== step.claim.controlConstraints.length)
        invalidSource('INVALID_NATIVE_OPTION_SOURCE_ACCOUNTING');
      const { claimAccounting: _accounting, ...claim } = step.claim;
      return { ...step, sourceText, instruction: sourceText, sourceInstructionSpan,
        claim: { ...claim, optionLabel, optionSourceSpan,
          controlConstraints: claim.controlConstraints.map((constraint, i) =>
            ({ ...constraint, ...controls.get(i)! })) } };
    }
    return step.type === 'verification_goal' ? { ...step, sourceText, instruction: sourceText, sourceInstructionSpan } :
      { ...step, sourceText, sourceInstructionSpan };
  });
  const normalized = { kind: 'extraction' as const, steps: normalizeSteps(steps.parse(derived)),
    instructionAccounting: instructionAccountingSchema.parse(instructionAccounting) };
  return JSON.stringify(ActionExtractionV2ResponseSchema.parse(normalized));
}

export function normalizePrimaryActionExtractionV4Wire(input: unknown, trustedSource: string): string {
  const { response } = PrimaryActionExtractionV4WireSchema.parse(input);
  return response.kind === 'extraction' ? normalizeUntextedExtraction(trustedSource, response) :
    normalizeUnspannedDecision(trustedSource, response);
}
export function normalizeIndependentActionExtractionV4Wire(input: unknown, trustedSource: string): string {
  const { response } = IndependentActionExtractionV4WireSchema.parse(input);
  return response.kind === 'source_extraction' ? normalizeUntextedExtraction(trustedSource,
    { steps: response.clauses, instructionAccounting: response.instructionAccounting }) :
    normalizeUnspannedDecision(trustedSource, response);
}

function normalizeForwardExtractionFromAccounting(source: string, stepsInput: z.infer<typeof forwardSteps>,
  sourceAccounting: z.infer<typeof forwardInstructionAccounting>): string {
  // Exact source order supplies the clause-to-step index; it never searches for a matching clause.
  let clauseIndex = 0;
  const instructionAccounting = sourceAccounting.map((segment) => {
    if (segment.classification !== 'clause') return segment;
    const step = stepsInput[clauseIndex++];
    if (!step) invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
    return { ...segment, stepId: step.id };
  });
  if (clauseIndex !== stepsInput.length) invalidSource('CLAUSE_OWNERSHIP_OR_ORDER');
  const stepsWithReverseOwnership = stepsInput.map((step) => {
    if (step.type !== 'action_goal') return step;
    uniqueIds(step.sourceAccounting.map((segment) => segment.id), 'DUPLICATE_SEGMENT_ID');
    uniqueIds(step.obligations.map((obligation) => obligation.id), 'DUPLICATE_OBLIGATION_ID');
    const reverse = new Map(step.sourceAccounting.map((segment) => [segment.id, [] as string[]]));
    for (const obligation of step.obligations) {
      uniqueIds(obligation.sourceSegmentIds, 'DUPLICATE_PROVENANCE_REFERENCE');
      for (const segmentId of obligation.sourceSegmentIds) {
        const owners = reverse.get(segmentId);
        if (!owners) invalidSource('UNKNOWN_OR_UNORDERED_PROVENANCE');
        owners.push(obligation.id);
      }
    }
    for (const anchor of step.anchors) {
      uniqueIds(anchor.sourceSegmentIds, 'DUPLICATE_PROVENANCE_REFERENCE');
      if (anchor.sourceSegmentIds.some((segmentId) => !reverse.has(segmentId)))
        invalidSource('UNKNOWN_OR_UNORDERED_PROVENANCE');
    }
    const sourceAccounting = step.sourceAccounting.map((segment) => {
      const obligationIds = reverse.get(segment.id)!;
      if (segment.classification !== 'neutral' && segment.classification !== 'unresolved' && !obligationIds.length)
        invalidSource('ILLEGAL_SEGMENT_OWNER');
      if ((segment.classification === 'neutral' || segment.classification === 'unresolved') && obligationIds.length)
        invalidSource('ILLEGAL_SEGMENT_OWNER');
      return { ...segment, obligationIds };
    });
    return { ...step, sourceStepId: step.id, sourceAccounting };
  });
  return normalizeUntextedExtraction(source, { steps: untextedSteps.parse(stepsWithReverseOwnership),
    instructionAccounting: unspannedInstructionAccounting.parse(instructionAccounting) });
}

function normalizeForwardExtraction(source: string, input: {
  steps: z.infer<typeof forwardSteps>; instructionAccounting: z.infer<typeof forwardInstructionAccounting>;
}): string {
  return normalizeForwardExtractionFromAccounting(source, input.steps,
    trustedFramedInstructionAccounting(source, input.instructionAccounting));
}

function normalizeClassifiedExtraction(source: string, input: {
  steps: z.infer<typeof singleSourceSteps>; instructionAccounting: z.infer<typeof classifiedInstructionAccounting>;
}): string {
  const instructionAccounting = trustedClassifiedInstructionAccounting(source, input.steps, input.instructionAccounting);
  const untexted = input.steps.map((step) => {
    if (step.type === 'action_goal' || 'verificationVersion' in step) return step;
    const { sourceText: _sourceText, ...rest } = step;
    return rest;
  });
  return normalizeForwardExtractionFromAccounting(source, forwardSteps.parse(untexted), instructionAccounting);
}

export function normalizePrimaryActionExtractionV5Wire(input: unknown, trustedSource: string): string {
  const { response } = PrimaryActionExtractionV5WireSchema.parse(input);
  return response.kind === 'extraction' ? normalizeForwardExtraction(trustedSource, response) :
    normalizeUnspannedDecision(trustedSource, response);
}
export function normalizeIndependentActionExtractionV5Wire(input: unknown, trustedSource: string): string {
  const { response } = IndependentActionExtractionV5WireSchema.parse(input);
  return response.kind === 'source_extraction' ? normalizeForwardExtraction(trustedSource,
    { steps: response.clauses, instructionAccounting: response.instructionAccounting }) :
    normalizeUnspannedDecision(trustedSource, response);
}
export function normalizePrimaryActionExtractionV6Wire(input: unknown, trustedSource: string): string {
  const { response } = PrimaryActionExtractionV6WireSchema.parse(input);
  return response.kind === 'extraction' ? normalizeClassifiedExtraction(trustedSource, response) :
    normalizeUnspannedDecision(trustedSource, response);
}
export function normalizeIndependentActionExtractionV6Wire(input: unknown, trustedSource: string): string {
  const { response } = IndependentActionExtractionV6WireSchema.parse(input);
  return response.kind === 'source_extraction' ? normalizeClassifiedExtraction(trustedSource,
    { steps: response.clauses, instructionAccounting: response.instructionAccounting }) :
    normalizeUnspannedDecision(trustedSource, response);
}
export const ActionExtractionV2ResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('extraction'),
    steps: z.array(DeferredAuthoredStepV2Schema).min(1).max(100), instructionAccounting }), ambiguity, unresolved,
]);
export type ActionExtractionV2Response = z.infer<typeof ActionExtractionV2ResponseSchema>;
