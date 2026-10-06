import { admitSemanticIntentV3, parseSemanticIntentTestSpecV3, TrustedSemanticSourceV3Schema,
  type SemanticIntentTestSpecV3, type TrustedSemanticIntentAdmissionV3,
  type TrustedSemanticSourceV3 } from '../domain/semantic-intent-v3.js';
import { SemanticIntentFidelityWireV3Schema, SemanticIntentPrimaryWireV3Schema } from './semantic-intent-v3-wire.js';

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

export function normalizeSemanticIntentV3(sourceInput: unknown,
  extractionInput: unknown): SemanticIntentTestSpecV3 {
  const source = TrustedSemanticSourceV3Schema.parse(sourceInput);
  const wire = SemanticIntentPrimaryWireV3Schema.parse(extractionInput);
  if (wire.response.kind !== 'extraction') throw new Error('SEMANTIC_INTERPRETATION_UNRESOLVED');
  return parseSemanticIntentTestSpecV3({ ...source, schemaVersion: '7', sourceContractVersion: '3',
    semanticMode: 'intent_v2', normalizationVersion: 'semantic_intent_normalization_v2',
    steps: wire.response.steps });
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
  { kind: 'rejected'; code: 'PROVIDER_OUTPUT_INVALID' | 'SEMANTIC_INTERPRETATION_UNRESOLVED' |
    'SEMANTIC_FIDELITY_MISMATCH' | 'INVALID_SOURCE_REPRESENTATION'; issues?: unknown[] };

/** Explicit opt-in interpretation path. It has no browser or production-grounding caller. */
export async function interpretSemanticIntentV3(sourceInput: TrustedSemanticSourceV3,
  models: SemanticIntentModelsV3, signal: AbortSignal = new AbortController().signal): Promise<SemanticIntentOutcomeV3> {
  let source: TrustedSemanticSourceV3;
  try { source = TrustedSemanticSourceV3Schema.parse(sourceInput); }
  catch { return { kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION' }; }
  let primary: unknown;
  try { primary = SemanticIntentPrimaryWireV3Schema.parse(JSON.parse(await models.primary.complete({
    systemInstruction: SEMANTIC_INTENT_PRIMARY_V3_PROMPT, userInstruction: source.sourceInstruction, signal })));
  } catch { return { kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID' }; }
  if ((primary as ReturnType<typeof SemanticIntentPrimaryWireV3Schema.parse>).response.kind !== 'extraction')
    return { kind: 'rejected', code: 'SEMANTIC_INTERPRETATION_UNRESOLVED' };
  let spec: SemanticIntentTestSpecV3;
  try { spec = normalizeSemanticIntentV3(source, primary); }
  catch { return { kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION' }; }
  let review: ReturnType<typeof SemanticIntentFidelityWireV3Schema.parse>;
  try { review = SemanticIntentFidelityWireV3Schema.parse(JSON.parse(await models.reviewer.complete({
    systemInstruction: SEMANTIC_INTENT_FIDELITY_V3_PROMPT,
    userInstruction: JSON.stringify({ originalInstruction: source.sourceInstruction,
      semanticIntent: semanticIntentFidelityProjectionV3(spec) }), signal })));
  } catch { return { kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID' }; }
  if (review.response.verdict !== 'faithful' || review.response.issues.length)
    return { kind: 'rejected', code: 'SEMANTIC_FIDELITY_MISMATCH', issues: review.response.issues };
  if (semanticIntentMaterialLiteralMismatchV3(spec))
    return { kind: 'rejected', code: 'SEMANTIC_FIDELITY_MISMATCH', issues: [{ kind: 'changed_literal',
      sourceStep: null, summary: 'An explicit authored literal is missing or changed.' }] };
  try { return { kind: 'accepted', admission: admitSemanticIntentV3(source, spec, review.response) }; }
  catch { return { kind: 'rejected', code: 'INVALID_SOURCE_REPRESENTATION' }; }
}
