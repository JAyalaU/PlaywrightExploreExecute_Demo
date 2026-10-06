import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApprovedAbsoluteUrlSchema, ExecutionProfileRefSchema } from './schema.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const phrase = z.string().min(1).max(1024);
const nullablePhrase = phrase.nullable();
const dependency = id.nullable();

/** Authored identity only. None of these fields is a locator or a browser-derived role. */
export const SemanticTargetIntentV3Schema = z.strictObject({
  category: nullablePhrase,
  exactName: nullablePhrase,
  context: nullablePhrase,
  ordinal: z.number().int().min(1).max(100).nullable(),
  relation: z.enum(['unspecified', 'same_as_step', 'created_by_step', 'any_matching']),
  relatedStepId: dependency,
});
export type SemanticTargetIntentV3 = z.infer<typeof SemanticTargetIntentV3Schema>;

const navigation = z.strictObject({ id, type: z.literal('navigate'), authoredText: phrase,
  url: ApprovedAbsoluteUrlSchema, dependsOnStepId: dependency });
const action = z.strictObject({ id, type: z.literal('action_intent'), authoredText: phrase,
  target: SemanticTargetIntentV3Schema,
  desiredEffect: z.enum(['activate', 'choose', 'set_value', 'set_checked']),
  value: nullablePhrase, checkedState: z.boolean().nullable(),
  /** Only a browser mechanic the author explicitly requires may appear here. */
  authoredMechanic: z.enum(['click', 'type', 'press']).nullable(),
  dependsOnStepId: dependency });
const verification = z.strictObject({ id, type: z.literal('verification_intent'), authoredText: phrase,
  subject: z.union([SemanticTargetIntentV3Schema, z.null()]),
  observable: z.enum(['exists', 'visible', 'enabled', 'checked', 'selected', 'value', 'url', 'cardinality']),
  comparator: z.enum(['equals', 'at_least', 'at_most']),
  expected: z.union([z.boolean(), phrase, z.number().int().min(0).max(10000)]),
  dependsOnStepId: dependency });
export const SemanticIntentStepV3Schema = z.discriminatedUnion('type', [navigation, action, verification]);
export type SemanticIntentStepV3 = z.infer<typeof SemanticIntentStepV3Schema>;

export const TrustedSemanticSourceV3Schema = z.strictObject({ testSpecId: id,
  sourceInstruction: z.string().min(1).max(16384), executionProfileRef: ExecutionProfileRefSchema,
  startState: z.strictObject({ url: z.union([ApprovedAbsoluteUrlSchema, z.literal('about:blank')]) }) });
export type TrustedSemanticSourceV3 = z.infer<typeof TrustedSemanticSourceV3Schema>;

export const SemanticIntentTestSpecV3Schema = TrustedSemanticSourceV3Schema.extend({
  schemaVersion: z.literal('7'), sourceContractVersion: z.literal('3'), semanticMode: z.literal('intent_v2'),
  normalizationVersion: z.literal('semantic_intent_normalization_v2'),
  steps: z.array(SemanticIntentStepV3Schema).min(1).max(100),
});
export type SemanticIntentTestSpecV3 = z.infer<typeof SemanticIntentTestSpecV3Schema>;

export function parseSemanticIntentTestSpecV3(input: unknown): SemanticIntentTestSpecV3 {
  const spec = SemanticIntentTestSpecV3Schema.parse(input);
  const prior = new Set<string>();
  for (const step of spec.steps) {
    if (prior.has(step.id)) throw new Error('DUPLICATE_STEP_ID');
    if (step.dependsOnStepId && !prior.has(step.dependsOnStepId)) throw new Error('INVALID_STEP_DEPENDENCY');
    if (step.type === 'action_intent' || step.type === 'verification_intent' && step.subject) {
      const target = step.type === 'action_intent' ? step.target : step.subject!;
      if ((target.relation === 'same_as_step' || target.relation === 'created_by_step') !== !!target.relatedStepId ||
          target.relatedStepId && !prior.has(target.relatedStepId)) throw new Error('INVALID_TARGET_RELATION');
      if (target.ordinal !== null && target.relation === 'any_matching') throw new Error('CONFLICTING_TARGET_IDENTITY');
    }
    if (step.type === 'action_intent') {
      if ((step.desiredEffect === 'choose' || step.desiredEffect === 'set_value') !== (step.value !== null) ||
          (step.desiredEffect === 'set_checked') !== (step.checkedState !== null))
        throw new Error('INVALID_ACTION_EFFECT_ARGUMENT');
    }
    if (step.type === 'verification_intent') {
      if ((step.observable === 'url') !== (step.subject === null) ||
          (['exists', 'visible', 'enabled', 'checked', 'selected'].includes(step.observable) &&
            (typeof step.expected !== 'boolean' || step.comparator !== 'equals')) ||
          (['value', 'url'].includes(step.observable) &&
            (typeof step.expected !== 'string' || step.comparator !== 'equals')) ||
          (step.observable === 'cardinality' && typeof step.expected !== 'number'))
        throw new Error('INVALID_VERIFICATION_PREDICATE');
    }
    prior.add(step.id);
  }
  return spec;
}

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stable(Reflect.get(value, key))}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

export const SEMANTIC_INTENT_ADMISSION_V3_VERSIONS = Object.freeze({ goalContractVersion: '3' as const,
  primaryExtractionVersion: 'qa_deferred_semantic_intent_primary_v2',
  independentExtractionVersion: 'qa_deferred_semantic_intent_fidelity_v2',
  primaryPromptVersion: 'deferred_semantic_intent_primary_p2',
  independentPromptVersion: 'deferred_semantic_intent_fidelity_p2',
  normalizationVersion: 'semantic_intent_normalization_v2' });

export const SemanticIntentFidelityVerdictV3Schema = z.strictObject({
  verdict: z.enum(['faithful', 'not_faithful']),
  issues: z.array(z.strictObject({ kind: z.enum(['missing_requirement', 'changed_literal', 'changed_polarity',
    'changed_order', 'invented_requirement', 'changed_target', 'unsupported_meaning']),
    sourceStep: z.number().int().min(1).max(100).nullable(), summary: z.string().min(1).max(160) })).max(8),
});
export type SemanticIntentFidelityVerdictV3 = z.infer<typeof SemanticIntentFidelityVerdictV3Schema>;

export const SemanticIntentAdmissionRecordV3Schema = z.strictObject({ admissionVersion: z.literal('3'),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), specDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  versions: z.strictObject({ goalContractVersion: z.literal('3'),
    primaryExtractionVersion: z.literal('qa_deferred_semantic_intent_primary_v2'),
    independentExtractionVersion: z.literal('qa_deferred_semantic_intent_fidelity_v2'),
    primaryPromptVersion: z.literal('deferred_semantic_intent_primary_p2'),
    independentPromptVersion: z.literal('deferred_semantic_intent_fidelity_p2'),
    normalizationVersion: z.literal('semantic_intent_normalization_v2') }),
});
export type SemanticIntentAdmissionRecordV3 = z.infer<typeof SemanticIntentAdmissionRecordV3Schema>;

const issued = new WeakSet<object>();
export type TrustedSemanticIntentAdmissionV3 = Readonly<{ spec: SemanticIntentTestSpecV3;
  record: SemanticIntentAdmissionRecordV3 }>;

/** This issuer has no browser handoff. A verdict alone cannot forge an accepted artifact. */
export function admitSemanticIntentV3(sourceInput: unknown, specInput: unknown,
  verdictInput: unknown): TrustedSemanticIntentAdmissionV3 {
  const source = TrustedSemanticSourceV3Schema.parse(sourceInput);
  const spec = parseSemanticIntentTestSpecV3(specInput);
  const verdict = SemanticIntentFidelityVerdictV3Schema.parse(verdictInput);
  if (stable({ testSpecId: spec.testSpecId, sourceInstruction: spec.sourceInstruction,
    executionProfileRef: spec.executionProfileRef, startState: spec.startState }) !== stable(source))
    throw new Error('TRUSTED_SOURCE_MISMATCH');
  if (verdict.verdict !== 'faithful' || verdict.issues.length) throw new Error('SEMANTIC_FIDELITY_MISMATCH');
  const record = SemanticIntentAdmissionRecordV3Schema.parse({ admissionVersion: '3',
    sourceDigest: hash(source), specDigest: hash(spec), reviewerDigest: hash(verdict),
    versions: SEMANTIC_INTENT_ADMISSION_V3_VERSIONS });
  const admission = Object.freeze({ spec: Object.freeze(spec), record: Object.freeze(record) });
  issued.add(admission);
  return admission;
}

export function requireTrustedSemanticIntentAdmissionV3(value: TrustedSemanticIntentAdmissionV3): void {
  if (!issued.has(value)) throw new Error('UNTRUSTED_SEMANTIC_INTENT_ADMISSION');
}
