import { ZodError } from 'zod';
import { admitSemanticIntentV3, parseSemanticIntentTestSpecStructureV3,
  parseSemanticIntentTestSpecV3, SemanticIntentValidationErrorV3,
  TrustedSemanticSourceV3Schema,
  type SemanticIntentTestSpecV3, type TrustedSemanticIntentAdmissionV3,
  type TrustedSemanticSourceV3 } from '../domain/semantic-intent-v3.js';
import { SemanticIntentFidelityWireV3Schema, SemanticIntentPrimaryWireV3Schema } from './semantic-intent-v3-wire.js';
import { canonicalizeSemanticRelationsV3, SemanticRelationCanonicalizationErrorV3 } from
  './semantic-intent-v3-relations.js';
import { ModelCompletionFailure } from './model-failure.js';
import { semanticPrimaryWireFailureDiagnosticV1,
  type SemanticPrimaryOutputDiagnosticV1 } from './semantic-primary-output-diagnostic-v1.js';

export const SEMANTIC_INTENT_PRIMARY_V3_PROMPT = [
  'Extract the original browser-test instruction as ordered semantic intent. Return only the closed JSON response.',
  'Describe the desired effect or resulting observable state, not a Playwright or MCP command.',
  'Use activate, choose, set_value, or set_checked. For check/uncheck preserve checkedState true/false; do not turn it into click or toggle.',
  'Record click/type/press only in authoredMechanic when the author explicitly requires that mechanic. Otherwise use null.',
  'For verification preserve exists, visible, enabled, checked, selected, value, URL, or cardinality, including false polarity and exact literals.',
  'Preserve an authored first/second/numbered identity as ordinal. Keep generic category, exact named/text target, and context separate.',
  'Do not invent an accessible name, browser role, locator, ordinal, or control ownership. Keep identity ambiguous when the instruction does.',
  'Use any_matching when the author permits any of repeated identical controls; never choose a first control on your own.',
  'Preserve ordering and explicit dependencies. Return unresolved when material intent cannot be represented.',
].join('\n');
export const SEMANTIC_INTENT_FIDELITY_V3_PROMPT = [
  'You are an independent semantic fidelity reviewer. Compare the original instruction to the semantic intent projection only.',
  'Validate every target meaning, desired effect/state, polarity, literal, order, dependency, ordinal/relationship, and explicit authored mechanic.',
  'Reject an invented exact accessible name, ordinal, constraint, operation, or control ownership. A contextual phrase is not an exact name.',
  'Check checkbox 1 means target category checkbox, ordinal first, desired checked state true. It does not require click or toggle.',
  'Reject omission of unchecked, disabled, absent, or required cardinality. Preserve ambiguity when repeated controls lack authored identity.',
  'Do not require browser roles, locators, native control details, or concrete operations that the author did not specify.',
  'Return faithful with no issues only if all material meaning is preserved. Otherwise return bounded not_faithful issues.',
].join('\n');

export type SemanticNormalizationDiagnosticV3 = Readonly<{
  phase: 'source' | 'wire' | 'spec_schema' | 'spec_cross_step' | 'relation_canonicalization' | 'admission';
  predicate: 'SCHEMA_TYPE_MISMATCH' | 'INVALID_STEP_SHAPE' | 'UNSUPPORTED_ACTION_KIND' |
    'UNSUPPORTED_VERIFICATION_KIND' | 'MISSING_TARGET' | 'INVALID_RELATION_COMBINATION' |
    'INVALID_ORDINAL_RELATION_COMBINATION' | 'INVALID_RELATION_REFERENCE' |
    'CLAUSE_OWNERSHIP_UNRESOLVED' | 'INVALID_CARDINALITY_VALUE' | 'INVALID_STEP_DEPENDENCY' |
    'MALFORMED_REPETITION_EXPANSION' | 'CONTRADICTORY_TARGET_CONSTRAINTS' |
    'DUPLICATE_STEP_ID' | 'INVALID_TARGET_RELATION' | 'CONFLICTING_TARGET_IDENTITY' |
    'INVALID_ACTION_EFFECT_ARGUMENT' | 'INVALID_VERIFICATION_PREDICATE' |
    'TRUSTED_SOURCE_MISMATCH' | 'OTHER_CLOSED_NORMALIZATION_VIOLATION';
  stepIndex: number | null;
  fieldFamily: 'source' | 'wire' | 'step_shape' | 'step_identity' | 'dependency' | 'target' |
    'relation' | 'ordinal' | 'action_argument' | 'verification_value' | 'admission';
}>;

class SemanticNormalizationFailureV3 extends Error {
  constructor(readonly diagnostic: SemanticNormalizationDiagnosticV3) { super(diagnostic.predicate); }
}

function normalizationDiagnostic(error: unknown, phase: SemanticNormalizationDiagnosticV3['phase']):
  SemanticNormalizationDiagnosticV3 {
  if (error instanceof SemanticNormalizationFailureV3) return error.diagnostic;
  if (error instanceof SemanticIntentValidationErrorV3)
    return { phase: 'spec_cross_step', predicate: error.predicate, stepIndex: error.stepIndex,
      fieldFamily: error.fieldFamily };
  if (error instanceof SemanticRelationCanonicalizationErrorV3)
    return { phase: 'relation_canonicalization', predicate: error.predicate, stepIndex: error.stepIndex,
      fieldFamily: error.predicate === 'INVALID_ORDINAL_RELATION_COMBINATION' ? 'ordinal' : 'relation' };
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const path = issue?.path ?? [];
    const stepPath = path.findIndex((part) => part === 'steps');
    const stepIndex = stepPath >= 0 && typeof path[stepPath + 1] === 'number' ?
      path[stepPath + 1] as number : null;
    const field = path.map(String);
    const family: SemanticNormalizationDiagnosticV3['fieldFamily'] =
      field.includes('relation') || field.includes('relatedStepId') ? 'relation' :
        field.includes('ordinal') ? 'ordinal' :
          field.includes('target') || field.includes('subject') ? 'target' :
            field.includes('dependsOnStepId') ? 'dependency' :
              field.includes('expected') || field.includes('observable') ? 'verification_value' :
                field.includes('value') || field.includes('checkedState') || field.includes('desiredEffect') ?
                  'action_argument' : stepIndex !== null ? 'step_shape' : phase === 'source' ? 'source' : 'wire';
    const predicate: SemanticNormalizationDiagnosticV3['predicate'] =
      field.includes('target') && issue?.code === 'invalid_type' ? 'MISSING_TARGET' :
        field.includes('desiredEffect') ? 'UNSUPPORTED_ACTION_KIND' :
          field.includes('observable') ? 'UNSUPPORTED_VERIFICATION_KIND' :
            field.includes('expected') ? 'INVALID_VERIFICATION_PREDICATE' :
              stepIndex !== null ? 'INVALID_STEP_SHAPE' : 'SCHEMA_TYPE_MISMATCH';
    return { phase, predicate, stepIndex, fieldFamily: family };
  }
  return { phase, predicate: phase === 'admission' && error instanceof Error &&
    error.message === 'TRUSTED_SOURCE_MISMATCH' ? 'TRUSTED_SOURCE_MISMATCH' :
    'OTHER_CLOSED_NORMALIZATION_VIOLATION', stepIndex: null,
  fieldFamily: phase === 'admission' ? 'admission' : phase === 'source' ? 'source' : 'wire' };
}

function atBoundary<T>(phase: SemanticNormalizationDiagnosticV3['phase'], operation: () => T): T {
  try { return operation(); }
  catch (error) { throw new SemanticNormalizationFailureV3(normalizationDiagnostic(error, phase)); }
}

export function normalizeSemanticIntentV3(sourceInput: unknown,
  extractionInput: unknown): SemanticIntentTestSpecV3 {
  const source = atBoundary('source', () => TrustedSemanticSourceV3Schema.parse(sourceInput));
  const wire = atBoundary('wire', () => SemanticIntentPrimaryWireV3Schema.parse(extractionInput));
  if (wire.response.kind !== 'extraction') throw new Error('SEMANTIC_INTERPRETATION_UNRESOLVED');
  const extractedSteps = wire.response.steps;
  const structural = atBoundary('spec_schema', () => parseSemanticIntentTestSpecStructureV3({ ...source,
    schemaVersion: '7', sourceContractVersion: '3',
    semanticMode: 'intent_v2', normalizationVersion: 'semantic_intent_normalization_v2',
    steps: extractedSteps }));
  const canonical = atBoundary('relation_canonicalization', () =>
    canonicalizeSemanticRelationsV3(source, structural));
  return atBoundary('spec_schema', () => parseSemanticIntentTestSpecV3(canonical));
}

/** The reviewer sees source meaning only; implementation mechanics have no fields here. */
export function semanticIntentFidelityProjectionV3(spec: SemanticIntentTestSpecV3) {
  return { schemaVersion: spec.schemaVersion, sourceContractVersion: spec.sourceContractVersion,
    steps: spec.steps.map((step) => step.type === 'navigate' ?
      { id: step.id, kind: step.type, authoredText: step.authoredText, url: step.url,
        dependsOnStepId: step.dependsOnStepId } : step.type === 'action_intent' ?
        { id: step.id, kind: step.type, authoredText: step.authoredText, targetIntent: step.target,
          desiredEffect: step.desiredEffect, value: step.value, checkedState: step.checkedState,
          explicitAuthoredMechanic: step.authoredMechanic, dependsOnStepId: step.dependsOnStepId } :
        { id: step.id, kind: step.type, authoredText: step.authoredText, subjectIntent: step.subject,
          observable: step.observable, comparator: step.comparator, expected: step.expected,
          dependsOnStepId: step.dependsOnStepId }) };
}

/** Exact authored literals get a deterministic guard in addition to independent semantic review. */
export function semanticIntentMaterialLiteralMismatchV3(spec: SemanticIntentTestSpecV3): boolean {
  const source = spec.sourceInstruction;
  const urls = [...source.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) =>
    match[0]!.replace(/[.,;!?]+$/, ''));
  const claimedUrls = spec.steps.flatMap((step) => step.type === 'navigate' ? [step.url] :
    step.type === 'verification_intent' && step.observable === 'url' && typeof step.expected === 'string' ?
      [step.expected] : []);
  const choices = [...source.matchAll(/\b(?:select|choose)\s+(Option\s+\d+)\b/gi)].map((match) => match[1]!);
  const claimedChoices = spec.steps.flatMap((step) => step.type === 'action_intent' &&
    step.desiredEffect === 'choose' && step.value !== null ? [step.value] : []);
  const enteredValues = [...source.matchAll(/\b(?:enter|fill|type)\s+(?:the\s+)?(?:text\s+)?["']([^"'\r\n]{1,512})["']/gi)]
    .map((match) => match[1]!);
  const claimedValues = spec.steps.flatMap((step) => step.type === 'action_intent' &&
    step.desiredEffect === 'set_value' && step.value !== null ? [step.value] : []);
  const normalizeChoice = (value: string) => value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
  return urls.some((url, index) => claimedUrls[index] !== url) ||
    choices.some((choice, index) => normalizeChoice(claimedChoices[index] ?? '') !== normalizeChoice(choice)) ||
    enteredValues.some((value, index) => claimedValues[index] !== value);
}

type Model = { complete(input: { systemInstruction: string; userInstruction: string;
  signal: AbortSignal }): Promise<string> };
export type SemanticIntentModelsV3 = { primary: Model; reviewer: Model };
export type SemanticIntentOutcomeV3 = { kind: 'accepted'; admission: TrustedSemanticIntentAdmissionV3 } |
  { kind: 'rejected'; code: 'PROVIDER_OUTPUT_INVALID' | 'REVIEWER_OUTPUT_INVALID' |
    'SEMANTIC_INTERPRETATION_UNRESOLVED' |
    'SEMANTIC_FIDELITY_MISMATCH' | 'INVALID_SOURCE_REPRESENTATION' | 'PROVIDER_ERROR' |
    'PROVIDER_TIMEOUT' | 'MODEL_ERROR' | 'MODEL_TIMEOUT'; issues?: unknown[];
    normalizationDiagnostic?: SemanticNormalizationDiagnosticV3;
    primaryOutputDiagnostic?: SemanticPrimaryOutputDiagnosticV1 };

function modelFailureCode(error: unknown): 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'MODEL_ERROR' | 'MODEL_TIMEOUT' {
  if (!(error instanceof ModelCompletionFailure)) return 'MODEL_ERROR';
  if (error.code === 'PROVIDER_TIMEOUT') return 'PROVIDER_TIMEOUT';
  if (error.code === 'PROVIDER_ERROR' || error.code === 'PROVIDER_CONFIGURATION_ERROR' ||
      error.code === 'PROVIDER_INPUT_INVALID') return 'PROVIDER_ERROR';
  return 'MODEL_ERROR';
}

/** Explicit opt-in interpretation path. It has no browser or production-grounding caller. */
export async function interpretSemanticIntentV3(sourceInput: TrustedSemanticSourceV3,
  models: SemanticIntentModelsV3, signal: AbortSignal = new AbortController().signal): Promise<SemanticIntentOutcomeV3> {
  let source: TrustedSemanticSourceV3;
  try { source = TrustedSemanticSourceV3Schema.parse(sourceInput); }
  catch (error) { return { kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: normalizationDiagnostic(error, 'source') }; }
  let primary: unknown;
  let primaryParsed: unknown;
  let primaryOutput: string;
  try { primaryOutput = await models.primary.complete({
    systemInstruction: SEMANTIC_INTENT_PRIMARY_V3_PROMPT, userInstruction: source.sourceInstruction, signal });
  } catch (error) {
    const detail = error instanceof ModelCompletionFailure &&
      ['PROVIDER_OUTPUT_INVALID', 'PROVIDER_REFUSAL', 'PROVIDER_INCOMPLETE'].includes(error.code) ?
      error.semanticPrimaryDiagnostic : undefined;
    return detail ? { kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID', primaryOutputDiagnostic: detail } :
      { kind: 'rejected', code: modelFailureCode(error) };
  }
  try { primaryParsed = JSON.parse(primaryOutput);
    primary = SemanticIntentPrimaryWireV3Schema.parse(primaryParsed);
  } catch (error) { return { kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID',
    primaryOutputDiagnostic: semanticPrimaryWireFailureDiagnosticV1(error, undefined, primaryParsed) }; }
  if ((primary as ReturnType<typeof SemanticIntentPrimaryWireV3Schema.parse>).response.kind !== 'extraction')
    return { kind: 'rejected', code: 'SEMANTIC_INTERPRETATION_UNRESOLVED' };
  let spec: SemanticIntentTestSpecV3;
  try { spec = normalizeSemanticIntentV3(source, primary); }
  catch (error) { return { kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: normalizationDiagnostic(error, 'spec_schema') }; }
  let review: ReturnType<typeof SemanticIntentFidelityWireV3Schema.parse>;
  let reviewerOutput: string;
  try { reviewerOutput = await models.reviewer.complete({
    systemInstruction: SEMANTIC_INTENT_FIDELITY_V3_PROMPT,
    userInstruction: JSON.stringify({ originalInstruction: source.sourceInstruction,
      semanticIntent: semanticIntentFidelityProjectionV3(spec) }), signal });
  } catch (error) {
    if (error instanceof ModelCompletionFailure &&
        ['PROVIDER_OUTPUT_INVALID', 'PROVIDER_REFUSAL', 'PROVIDER_INCOMPLETE',
          'PROVIDER_RESPONSE_TOO_LARGE'].includes(error.code))
      return { kind: 'rejected', code: 'REVIEWER_OUTPUT_INVALID' };
    return { kind: 'rejected', code: modelFailureCode(error) };
  }
  try { review = SemanticIntentFidelityWireV3Schema.parse(JSON.parse(reviewerOutput)); }
  catch { return { kind: 'rejected', code: 'REVIEWER_OUTPUT_INVALID' }; }
  if (review.response.verdict !== 'faithful' || review.response.issues.length)
    return { kind: 'rejected', code: 'SEMANTIC_FIDELITY_MISMATCH', issues: review.response.issues };
  if (semanticIntentMaterialLiteralMismatchV3(spec))
    return { kind: 'rejected', code: 'SEMANTIC_FIDELITY_MISMATCH', issues: [{ kind: 'changed_literal',
      sourceStep: null, summary: 'An explicit authored literal is missing or changed.' }] };
  try { return { kind: 'accepted', admission: admitSemanticIntentV3(source, spec, review.response) }; }
  catch (error) { return { kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION',
    normalizationDiagnostic: normalizationDiagnostic(error, 'admission') }; }
}
