import { createHash } from 'node:crypto';
import type { SemanticIntentStepV3, SemanticIntentTestSpecV3, SemanticTargetIntentV3,
  TrustedSemanticSourceV3 } from '../domain/semantic-intent-v3.js';

export class SemanticRelationCanonicalizationErrorV3 extends Error {
  constructor(readonly predicate: 'CLAUSE_OWNERSHIP_UNRESOLVED' | 'INVALID_RELATION_COMBINATION' |
    'INVALID_ORDINAL_RELATION_COMBINATION' | 'INVALID_RELATION_REFERENCE' |
    'MALFORMED_REPETITION_EXPANSION' | 'CONTRADICTORY_TARGET_CONSTRAINTS',
  readonly stepIndex: number) { super(predicate); }
}

/** Source clauses are ordered; a stated repetition owns successive identical action intents. */
function authoredClauses(source: string): string[] {
  return source.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/).map((part) =>
    part.trim().replace(/^\d+[.)]\s*/, '')).filter(Boolean);
}

function imperativeActionClause(clause: string): boolean {
  return /^(?:please\s+)?(?:find\s+and\s+)?(?:activate|click|press|check|uncheck|select|choose|fill|type|set|enter|remove|add)\b/i
    .test(clause) && !/^(?:please\s+)?check\s+(?:that|if|whether)\b/i.test(clause);
}

function repetitionCount(clause: string): number {
  if (!imperativeActionClause(clause)) return 1;
  if (/\b(?:twice|two\s+times)\b/i.test(clause)) return 2;
  if (/\b(?:thrice|three\s+times)\b/i.test(clause)) return 3;
  return Number(/\b(\d{1,2})\s+times\b/i.exec(clause)?.[1] ?? 1);
}

function authoredSlots(clauses: string[]): string[] {
  return clauses.flatMap((clause) => {
    const count = repetitionCount(clause);
    return Array.from({ length: Math.min(count, 100) }, () => clause);
  });
}

const normalize = (value: string | null): string | null => value?.trim().replace(/\s+/g, ' ')
  .toLocaleLowerCase('en-US') ?? null;
const sameDescription = (a: SemanticTargetIntentV3, b: SemanticTargetIntentV3): boolean =>
  normalize(a.category) === normalize(b.category) && normalize(a.exactName) === normalize(b.exactName) &&
  normalize(a.context) === normalize(b.context) && a.ordinal === b.ordinal;

function containsTerm(clause: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(clause);
}

function anchoredTarget(clause: string, target: SemanticTargetIntentV3,
  steps: SemanticIntentStepV3[], stepIndex: number): boolean {
  const quoted = [...clause.matchAll(/["']([^"'\r\n]{1,256})["']/g)].map((match) => match[1]!);
  if (quoted.length && (!target.exactName || !quoted.some((name) => normalize(name) === normalize(target.exactName))))
    return false;
  if (target.exactName && containsTerm(clause, target.exactName)) return true;
  const category = target.category;
  const hasCategory = category !== null && (containsTerm(clause, category) ||
    containsTerm(clause, `${category}s`) || containsTerm(clause, `${category}es`));
  if (!target.exactName) return hasCategory;
  if (!hasCategory || !/\b(?:same|that|those|these|just|newly|previously)\b/i.test(clause))
    return false;
  const prior = steps.slice(0, stepIndex).at(-1);
  const previousTarget = prior?.type === 'action_intent' ? prior.target :
    prior?.type === 'verification_intent' ? prior.subject : null;
  return previousTarget !== null && previousTarget !== undefined && sameDescription(previousTarget, target);
}

function priorIdentity(steps: SemanticIntentStepV3[], stepIndex: number,
  target: SemanticTargetIntentV3, clause: string): string | null {
  const candidates = steps.slice(0, stepIndex).filter((step): step is Extract<SemanticIntentStepV3,
    { type: 'action_intent' }> => step.type === 'action_intent' && sameDescription(step.target, target));
  if (candidates.length === 1) return candidates[0]!.id;
  if (candidates.length > 1 && /\b(?:previous|last|just\s+(?:used|activated))\b/i.test(clause))
    return candidates.at(-1)!.id;
  return null;
}

function priorChoice(steps: SemanticIntentStepV3[], stepIndex: number,
  target: SemanticTargetIntentV3): string | null {
  const matches = steps.slice(0, stepIndex).filter((step): step is Extract<SemanticIntentStepV3,
    { type: 'action_intent' }> => step.type === 'action_intent' && step.desiredEffect === 'choose' &&
      normalize(step.value) === normalize(target.exactName));
  return matches.length === 1 ? matches[0]!.id : null;
}

function priorCausalAction(steps: SemanticIntentStepV3[], stepIndex: number, clause: string): string | null {
  const actions = steps.slice(0, stepIndex).filter((step): step is Extract<SemanticIntentStepV3,
    { type: 'action_intent' }> => step.type === 'action_intent');
  const stepNumber = /\b(?:step|action)\s+(\d{1,2})\b/i.exec(clause)?.[1];
  if (stepNumber) return steps[Number(stepNumber) - 1]?.type === 'action_intent' ?
    steps[Number(stepNumber) - 1]!.id : null;
  const named = actions.filter((step) => step.target.exactName &&
    normalize(clause)?.includes(normalize(step.target.exactName)!));
  if (named.length === 1) return named[0]!.id;
  if (/\b(?:previous|last|just|newly)\b/i.test(clause)) return actions.at(-1)?.id ?? null;
  return actions.length === 1 ? actions[0]!.id : null;
}

/** Only trusted authored clauses can give a relation final semantic authority. */
export function canonicalizeSemanticRelationsV3(source: TrustedSemanticSourceV3,
  spec: SemanticIntentTestSpecV3): SemanticIntentTestSpecV3 {
  const clauses = authoredClauses(source.sourceInstruction);
  const slots = authoredSlots(clauses);
  const aligned = slots.length === spec.steps.length;
  if (!aligned && clauses.some((clause) => repetitionCount(clause) > 1))
    throw new SemanticRelationCanonicalizationErrorV3('MALFORMED_REPETITION_EXPANSION',
      Math.min(slots.length, spec.steps.length));
  const steps = spec.steps.map((step, stepIndex): SemanticIntentStepV3 => {
    if (step.type === 'navigate' || step.type === 'verification_intent' && step.subject === null) return step;
    const target = step.type === 'action_intent' ? step.target : step.subject!;
    const clause = aligned ? slots[stepIndex]! : null;
    if (target.relation !== 'unspecified' && clause === null &&
        !(step.type === 'verification_intent' && step.observable === 'selected' &&
          priorChoice(spec.steps, stepIndex, target)))
      throw new SemanticRelationCanonicalizationErrorV3('CLAUSE_OWNERSHIP_UNRESOLVED', stepIndex);
    const oneOf = clause !== null && /\b(?:one|any|either)\s+of\b/i.test(clause);
    const same = clause !== null && ( /\bsame\b/i.test(clause) ||
      /\b(?:activate|click|press|use|select|choose)\s+that\s+(?:button|field|control|checkbox|option|link)\b/i.test(clause));
    const created = clause !== null && /\b(?:(?:created|added|produced)\s+by|(?:just|newly|previously)\s+(?:created|added)|(?:button|control|element)\s+just\s+added)\b/i.test(clause);
    if (clause !== null && (oneOf || same || created) &&
        !anchoredTarget(clause, target, spec.steps, stepIndex))
      throw new SemanticRelationCanonicalizationErrorV3('CLAUSE_OWNERSHIP_UNRESOLVED', stepIndex);
    if (Number(oneOf) + Number(same) + Number(created) > 1)
      throw new SemanticRelationCanonicalizationErrorV3('CONTRADICTORY_TARGET_CONSTRAINTS', stepIndex);
    if (oneOf && target.ordinal !== null)
      throw new SemanticRelationCanonicalizationErrorV3('INVALID_ORDINAL_RELATION_COMBINATION', stepIndex);
    let relation: SemanticTargetIntentV3['relation'] = 'unspecified';
    let relatedStepId: string | null = null;
    if (step.type === 'verification_intent' && step.observable === 'cardinality') {
      if (target.ordinal !== null)
        throw new SemanticRelationCanonicalizationErrorV3('INVALID_ORDINAL_RELATION_COMBINATION', stepIndex);
      if (oneOf || same || created)
        throw new SemanticRelationCanonicalizationErrorV3('INVALID_RELATION_COMBINATION', stepIndex);
    } else if (oneOf) relation = 'any_matching';
    else if (same) {
      relatedStepId = priorIdentity(spec.steps, stepIndex, target, clause!);
      if (!relatedStepId) throw new SemanticRelationCanonicalizationErrorV3('INVALID_RELATION_REFERENCE', stepIndex);
      relation = 'same_as_step';
    } else if (created) {
      relatedStepId = priorCausalAction(spec.steps, stepIndex, clause!);
      if (!relatedStepId) throw new SemanticRelationCanonicalizationErrorV3('INVALID_RELATION_REFERENCE', stepIndex);
      relation = 'created_by_step';
    } else if (step.type === 'verification_intent' && step.observable === 'selected') {
      relatedStepId = clause !== null && anchoredTarget(clause, target, spec.steps, stepIndex) ?
        priorChoice(spec.steps, stepIndex, target) : null;
      if (relatedStepId) relation = 'same_as_step';
    }
    const canonical = { ...target, relation, relatedStepId };
    return step.type === 'action_intent' ? { ...step, target: canonical } : { ...step, subject: canonical };
  });
  return { ...spec, steps };
}

/** Experiment-only meaning digest: step IDs and model-authored paraphrases are excluded. */
export function semanticIntentCanonicalDigestV3(spec: SemanticIntentTestSpecV3): string {
  const index = new Map(spec.steps.map((step, position) => [step.id, position + 1]));
  const target = (value: SemanticTargetIntentV3 | null) => value === null ? null : {
    category: value.category, exactName: value.exactName, context: value.context,
    ordinal: value.ordinal, relation: value.relation,
    relatedStep: value.relatedStepId ? index.get(value.relatedStepId) : null,
  };
  const meaning = spec.steps.map((step) => ({
    type: step.type,
    dependency: step.dependsOnStepId ? index.get(step.dependsOnStepId) : null,
    ...(step.type === 'navigate' ? { url: step.url } :
      step.type === 'action_intent' ? { target: target(step.target), desiredEffect: step.desiredEffect,
        value: step.value, checkedState: step.checkedState, authoredMechanic: step.authoredMechanic } :
        { subject: target(step.subject), observable: step.observable, comparator: step.comparator,
          expected: step.expected }),
  }));
  return createHash('sha256').update(JSON.stringify(meaning)).digest('hex');
}
