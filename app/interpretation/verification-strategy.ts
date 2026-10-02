import { SUCCESSFUL_VERIFICATION_OBSERVATION_LIMIT, parseSuccessfulVerificationStrategyV1, type SuccessfulVerificationStrategyV1 } from '../domain/successful-verification-strategy.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TrustedObservationRequestV1Schema, type TrustedObservationRequestV1,
  TrustedObservationFrameProvenanceV1Schema, type TrustedObservationResultV1,
  type VerificationGoal, VerificationGoalSchema, verificationGoalFidelity,
  VerificationComparisonV1Schema, type VerificationComparisonV1 } from '../domain/index.js';
import { TrustedObservationSessionV1 } from '../exploration/trusted-observation.js';
import type { CurrentStateExploration } from '../exploration/index.js';
import type { SuccessfulPathRecordV1 } from '../domain/index.js';
import { ModelCompletionFailure } from './model-failure.js';
import { ActionCandidateGroundingSessionV1 } from '../exploration/action-candidate-grounding.js';
import type { ActionGroundingWitnessV1 } from '../domain/action-grounding-execution.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
export { VerificationComparisonV1Schema } from '../domain/verification-comparison.js';
export type { VerificationComparisonV1 } from '../domain/verification-comparison.js';

export const AgenticVerificationDecisionV4Schema = z.discriminatedUnion('kind', [
  z.strictObject({ decisionVersion: z.literal('4'), kind: z.literal('observe'),
    request: TrustedObservationRequestV1Schema }),
  z.strictObject({ decisionVersion: z.literal('4'), kind: z.literal('conclude'),
    conclusion: z.enum(['satisfied', 'unsatisfied', 'unresolved', 'unsupported']),
    comparison: VerificationComparisonV1Schema.optional() }),
]);
export type AgenticVerificationDecisionV4 = z.infer<typeof AgenticVerificationDecisionV4Schema>;
export const VERIFICATION_DECISION_INSTRUCTION = [
  'Determine how to establish the authored verification goal using only reviewed observations.',
  'Return exactly one decisionVersion 4 JSON decision: observe or conclude.',
  'A semantic snapshot is for inspection only. A complete semantic query proves zero or more matches.',
  'Existence is a match count, not visibility. A target property requires exactly one match.',
  'Use trusted observation IDs in comparisons. You cannot assert facts or provenance yourself.',
  'For a disappearance, use an earlier present count and later absent count across an action.',
  'If visual or spatial order lacks an observation primitive, conclude unsupported.',
  'If evidence is ambiguous or insufficient, conclude unresolved or request another observation.',
  'No selectors, JavaScript, DOM evaluation, network requests, or executable expressions.',
].join('\n');

export interface AgenticVerificationModelV4 {
  complete(input: { systemInstruction: string; context: VerificationDecisionContextV4;
    signal: AbortSignal }): Promise<string>;
}
export interface VerificationDecisionContextV4 {
  decisionVersion: '4'; goal: VerificationGoal; stepOrdinal: number;
  observations: readonly TrustedObservationResultV1[];
  priorObservations: readonly { observation: TrustedObservationResultV1; actionOrdinal: number }[];
  actionOrdinal: number; decisionsUsed: number;
}
const LIMITS = Object.freeze({ decisions: 12, observations: SUCCESSFUL_VERIFICATION_OBSERVATION_LIMIT, snapshots: 2,
  elapsedMs: 30_000, modelMs: 8_000, responseChars: 4_096, modelInputChars: 28_000 });
export const VERIFICATION_STRATEGY_LIMITS = LIMITS;

export { SuccessfulVerificationStrategyV1Schema, parseSuccessfulVerificationStrategyV1 } from '../domain/successful-verification-strategy.js';
export type { SuccessfulVerificationStrategyV1 } from '../domain/successful-verification-strategy.js';
export type VerificationEvaluationV1 = { conclusion: 'satisfied' | 'unsatisfied' | 'unresolved' | 'unsupported';
  strategy?: SuccessfulVerificationStrategyV1; reason?: string };

function digest(data: unknown): string { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function normalized(s: string): string { return s.trim().replace(/\s+/g, ' ').toLowerCase(); }
function authoredLiteral(goal: VerificationGoal, value: string): boolean {
  return !!value && normalized(goal.sourceText).includes(normalized(value));
}
function queryMatchesGoal(goal: VerificationGoal, request: TrustedObservationRequestV1): boolean {
  if (request.kind !== 'semantic_query' && request.kind !== 'target_property') return true;
  const subject = goal.subject;
  if (subject?.role && request.query.role !== subject.role) return false;
  if (!subject?.role && !authoredLiteral(goal, request.query.role) &&
      !(request.query.role === 'dialog' && /\bmodal\b/i.test(goal.sourceText))) return false;
  if (subject?.accessibleName && request.query.name !== subject.accessibleName) return false;
  if (request.query.name && !authoredLiteral(goal, request.query.name)) return false;
  if (subject?.scope?.length) {
    // A prose scope hint cannot silently become an unscoped, main-frame claim.
    if (!request.query.within?.length && request.query.frame.kind === 'main') return false;
  }
  return true;
}
function comparisonMeaning(goal: VerificationGoal, comparison: VerificationComparisonV1): boolean {
  const intent = goal.intent;
  if (intent?.kind === 'presence') return comparison.kind === 'count' &&
    (intent.expected === 'absent' ? comparison.operator === 'equal' && comparison.expected === 0 :
      comparison.operator === 'greater_than' && comparison.expected === 0 ||
      comparison.operator === 'at_least' && comparison.expected === 1);
  if (intent?.kind === 'cardinality') return comparison.kind === 'count' &&
    comparison.expected === intent.count && comparison.operator === intent.comparison;
  if (intent?.kind === 'property') return comparison.kind === 'boolean' &&
    comparison.property === intent.property && comparison.expected === intent.expected;
  if (intent?.kind === 'temporal') return comparison.kind === 'transition' &&
    comparison.operator === intent.transition;
  if (intent?.kind === 'relationship') return false;
  // An unhinted goal is allowed only when the comparison itself is grounded in
  // authored words. Unsupported phrasing stays unresolved rather than guessed.
  if (comparison.kind === 'count') {
    if (/\b(?:does not exist|not present|absent|no|zero)\b/i.test(goal.sourceText))
      return comparison.operator === 'equal' && comparison.expected === 0;
    if (/\bexist(?:s)?\b/i.test(goal.sourceText))
      return comparison.operator === 'greater_than' && comparison.expected === 0 ||
        comparison.operator === 'at_least' && comparison.expected === 1;
    const cardinality = { kind: 'cardinality' as const, comparison: comparison.operator === 'equal' ? 'equal' as const :
      comparison.operator === 'at_least' ? 'at_least' as const : 'at_most' as const, count: comparison.expected };
    if (comparison.operator !== 'greater_than' &&
        !verificationGoalFidelity({ ...goal, intent: cardinality }, goal.sourceText, [])) return true;
  }
  if (comparison.kind === 'boolean' && ['visible', 'enabled', 'checked'].includes(comparison.property))
    return !verificationGoalFidelity({ ...goal, intent: { kind: 'property',
      property: comparison.property as 'visible' | 'enabled' | 'checked', expected: comparison.expected } },
    goal.sourceText, []);
  if (comparison.kind === 'transition') return !verificationGoalFidelity({ ...goal,
    intent: { kind: 'temporal', transition: comparison.operator } }, goal.sourceText, []);
  if (comparison.kind === 'string') return authoredLiteral(goal, comparison.expected) &&
    (comparison.property === 'url' ? /\burl\b/i.test(goal.sourceText) :
      comparison.property === 'text' ? /\btext\b/i.test(goal.sourceText) : /\bvalue\b/i.test(goal.sourceText));
  return false;
}

/** Private, in-memory M7 verification reasoning. No trace, replay, or QA verdict. */
export class GoalDirectedVerificationControllerV1 {
  readonly #observations: TrustedObservationSessionV1;
  readonly #current: CurrentStateExploration | ActionCandidateGroundingSessionV1;
  readonly #model: AgenticVerificationModelV4;
  readonly #journal: SuccessfulVerificationStrategyV1[] = [];
  readonly #history: { observation: TrustedObservationResultV1; actionOrdinal: number }[] = [];
  #actionOrdinal = 0;
  constructor(observations: TrustedObservationSessionV1, current: CurrentStateExploration | ActionCandidateGroundingSessionV1,
    model: AgenticVerificationModelV4) {
    this.#observations = observations; this.#current = current; this.#model = model;
    if (current instanceof ActionCandidateGroundingSessionV1)
      TrustedObservationSessionV1.prototype.protectedDeferredOwner.call(observations, current);
    this.#actionOrdinal = current instanceof ActionCandidateGroundingSessionV1
      ? ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(current).length
      : current.successfulActions.length;
  }
  get successfulStrategies(): readonly SuccessfulVerificationStrategyV1[] { return structuredClone(this.#journal); }
  /** A temporal boundary needs an actual successful current-state action fact. */
  noteSuccessfulAction(record: SuccessfulPathRecordV1): void {
    if (this.#current instanceof ActionCandidateGroundingSessionV1) throw new Error('Deferred witness required');
    const actions = this.#current.successfulActions;
    if (actions.length !== this.#actionOrdinal + 1 ||
        !same(actions.at(-1)?.record, record) || record.preStateDigest === record.postStateDigest)
      throw new Error('Action provenance is not a successful mutation');
    this.#actionOrdinal++;
  }

  noteSuccessfulGroundingWitness(witness: ActionGroundingWitnessV1): void {
    if (!(this.#current instanceof ActionCandidateGroundingSessionV1)) throw new Error('Deferred runtime required');
    const actions = ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(this.#current);
    if (actions.length !== this.#actionOrdinal + 1 || !same(actions.at(-1), witness))
      throw new Error('Deferred action is absent from the protected successful journal');
    this.#actionOrdinal++;
  }
  protectedDeferredStrategy(runtime: ActionCandidateGroundingSessionV1, goalId: string,
    observations?: TrustedObservationSessionV1): SuccessfulVerificationStrategyV1 | undefined {
    if (this.#current !== runtime) throw new Error('Verification runtime owner mismatch');
    if (observations && observations !== this.#observations) throw new Error('Verification observation owner mismatch');
    TrustedObservationSessionV1.prototype.protectedDeferredOwner.call(this.#observations, runtime);
    ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(runtime);
    const matches = this.#journal.filter((s) => s.goalStepId === goalId);
    if (matches.length > 1) throw new Error('Duplicate successful verification strategy');
    return matches[0] ? structuredClone(matches[0]) : undefined;
  }

  async evaluate(goalInput: unknown, stepOrdinal: number, signal?: AbortSignal): Promise<VerificationEvaluationV1> {
    // Only the new source contract adds this mechanical instruction linkage.
    const deferredGoal = this.#current instanceof ActionCandidateGroundingSessionV1 && typeof goalInput === 'object' && goalInput !== null
      ? Object.fromEntries(Object.entries(goalInput).filter(([key]) => key !== 'sourceInstructionSpan')) : goalInput;
    const goal = VerificationGoalSchema.parse(deferredGoal);
    if (!Number.isInteger(stepOrdinal) || stepOrdinal < 0) throw new Error('Invalid step ordinal');
    const source = this.#current instanceof ActionCandidateGroundingSessionV1
      ? ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(this.#current).admission.spec
      : this.#current.source;
    const sourceIndex = source.steps.findIndex((step) => step.id === goal.id);
    const sourceStep = source.steps[sourceIndex];
    const semanticPoc = 'semanticMode' in source && source.semanticMode === 'poc_v1';
    if (sourceIndex !== stepOrdinal || !sourceStep || sourceStep.type !== 'verification_goal' ||
        'verificationVersion' in sourceStep ||
        normalized(sourceStep.sourceText) !== normalized(goal.sourceText) ||
        (sourceStep.intent && !same(sourceStep.intent, goal.intent)) ||
        (sourceStep.subject && !same(sourceStep.subject, goal.subject)) ||
        !semanticPoc && verificationGoalFidelity(goal, source.sourceInstruction,
          source.steps.slice(0, sourceIndex).map((step) => step.id)))
      return { conclusion: 'unresolved', reason: 'INTENT_NOT_PRESERVED' };
    if (semanticPoc) {
      const preceding = source.steps[stepOrdinal - 1];
      const urlGoal = /\b(?:url|takes?\s+(?:you\s+)?to)\b/i.test(goal.sourceText);
      const literals = goal.sourceText.match(/https?:\/\/[^\s<>"']+/g)?.map((value) => value.replace(/[.,;!?]+$/, '')) ?? [];
      if (urlGoal) {
        if (literals.length !== 1 || goal.subject || goal.intent || preceding?.type !== 'action_goal' ||
            goal.dependsOnStepId !== preceding.id || this.#actionOrdinal < 1 ||
            !source.sourceInstruction.includes(literals[0]!))
          return { conclusion: 'unresolved', reason: 'INTENT_NOT_PRESERVED' };
        let expected: string;
        try {
          const parsed = new URL(literals[0]!);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
            return { conclusion: 'unresolved', reason: 'UNSUPPORTED_COMPARISON' };
          expected = parsed.href;
        } catch { return { conclusion: 'unresolved', reason: 'UNSUPPORTED_COMPARISON' }; }
        let fact: TrustedObservationResultV1;
        try { fact = await this.#observations.observe({ kind: 'current_url' }); }
        catch { return { conclusion: 'unresolved', reason: 'OBSERVATION_ERROR' }; }
        if (fact.status !== 'complete' || fact.result.kind !== 'url' ||
            !(await this.#observations.currentEvidence(fact)))
          return { conclusion: 'unresolved', reason: 'EVIDENCE_INELIGIBLE' };
        const comparison: VerificationComparisonV1 = { kind: 'string', observationId: fact.observationId,
          property: 'url', operator: 'equal', expected };
        const evaluated = fact.result.value === expected;
        const data = { strategyVersion: '1', goalStepId: goal.id, observationIds: [fact.observationId],
          observations: [{ observationId: fact.observationId, request: fact.request, result: fact.result,
            witnessDigest: fact.witnessDigest, sessionId: fact.sessionId, pageId: fact.pageId,
            stateEpoch: fact.stateEpoch, mutationEpoch: fact.mutationEpoch,
            stateDigest: fact.stateDigest, observedAt: fact.observedAt, frame: fact.frame }],
          comparison, evaluated, conclusion: evaluated ? 'satisfied' as const : 'unsatisfied' as const,
          testSpecId: fact.testSpecId, explorationAttemptId: fact.explorationAttemptId,
          sessionId: fact.sessionId, pageId: fact.pageId, actionOrdinal: this.#actionOrdinal };
        const strategy = parseSuccessfulVerificationStrategyV1({ ...data, strategyDigest: digest(data) });
        this.#journal.push(structuredClone(strategy));
        return { conclusion: strategy.conclusion, strategy: structuredClone(strategy) };
      }
    }
    const deadline = Date.now() + LIMITS.elapsedMs;
    const facts: TrustedObservationResultV1[] = [];
    const requests = new Map<string, TrustedObservationResultV1>();
    let snapshots = 0;
    for (let decisionsUsed = 0; decisionsUsed < LIMITS.decisions; decisionsUsed++) {
      if (signal?.aborted) return { conclusion: 'unresolved', reason: 'CANCELLED' };
      const remaining = Math.min(LIMITS.modelMs, deadline - Date.now());
      if (remaining <= 0) return { conclusion: 'unresolved', reason: 'BUDGET_EXHAUSTED' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let output: string;
      try {
        const context: VerificationDecisionContextV4 = { decisionVersion: '4', goal, stepOrdinal,
          observations: structuredClone(facts),
          priorObservations: structuredClone(this.#history.slice(-LIMITS.observations)),
          actionOrdinal: this.#actionOrdinal, decisionsUsed };
        if (JSON.stringify(context).length > LIMITS.modelInputChars)
          return { conclusion: 'unresolved', reason: 'BUDGET_EXHAUSTED' };
        output = await Promise.race([this.#model.complete({ systemInstruction: VERIFICATION_DECISION_INSTRUCTION,
          context, signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort',
          () => reject(new Error('BUDGET_EXHAUSTED')), { once: true }))]);
      } catch (error) {
        return { conclusion: 'unresolved', reason: error instanceof ModelCompletionFailure ? error.code : 'BUDGET_EXHAUSTED' };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
      if (typeof output !== 'string' || output.length > LIMITS.responseChars)
        return { conclusion: 'unresolved', reason: 'INVALID_DECISION' };
      let parsed: unknown;
      try { parsed = JSON.parse(output); } catch { return { conclusion: 'unresolved', reason: 'INVALID_DECISION' }; }
      const decision = AgenticVerificationDecisionV4Schema.safeParse(parsed);
      if (!decision.success) return { conclusion: 'unresolved', reason: 'INVALID_DECISION' };
      if (decision.data.kind === 'observe') {
        const request = decision.data.request;
        if (facts.length >= LIMITS.observations || request.kind === 'semantic_snapshot' && snapshots >= LIMITS.snapshots)
          return { conclusion: 'unresolved', reason: 'BUDGET_EXHAUSTED' };
        const key = JSON.stringify(request);
        const previous = requests.get(key);
        if (previous && (previous.status === 'error' || previous.result.kind === 'snapshot' ||
            await this.#observations.currentEvidence(previous)))
          return { conclusion: 'unresolved', reason: 'NO_PROGRESS' };
        if (request.kind === 'semantic_snapshot') snapshots++;
        try { const fact = await this.#observations.observe(request); facts.push(fact); requests.set(key, fact); }
        catch { return { conclusion: 'unresolved', reason: 'OBSERVATION_ERROR' }; }
        continue;
      }
      if (decision.data.conclusion === 'unsupported') return { conclusion: 'unsupported' };
      if (decision.data.conclusion === 'unresolved') return { conclusion: 'unresolved' };
      const comparison = decision.data.comparison;
      if (!comparison || !comparisonMeaning(goal, comparison))
        return { conclusion: 'unresolved', reason: 'INTENT_NOT_PRESERVED' };
      if (comparison.kind === 'string') {
        if (comparison.property === 'url') {
          if (comparison.operator === 'contains') return { conclusion: 'unresolved', reason: 'UNSUPPORTED_COMPARISON' };
          const candidate = comparison.operator === 'url_prefix' ? comparison.expected.slice(0, -1) : comparison.expected;
          try {
            const url = new URL(candidate);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                comparison.operator === 'url_prefix' && (!comparison.expected.endsWith('/*') ||
                  comparison.expected.slice(0, -2).includes('*') || !url.pathname.endsWith('/')))
              return { conclusion: 'unresolved', reason: 'UNSUPPORTED_COMPARISON' };
          } catch { return { conclusion: 'unresolved', reason: 'UNSUPPORTED_COMPARISON' }; }
        } else if (comparison.operator === 'url_prefix')
          return { conclusion: 'unresolved', reason: 'UNSUPPORTED_COMPARISON' };
      }
      const ids = comparison.kind === 'transition' ? [comparison.earlierObservationId, comparison.laterObservationId] :
        [comparison.observationId];
      const selected = ids.map((id) => facts.find((fact) => fact.observationId === id) ??
        this.#history.find((entry) => entry.observation.observationId === id)?.observation);
      if (selected.some((fact) => !fact || fact.status !== 'complete' || fact.result.kind === 'snapshot'))
        return { conclusion: 'unresolved', reason: 'EVIDENCE_INELIGIBLE' };
      const records = selected as TrustedObservationResultV1[];
      const later = records.at(-1)!;
      if (!facts.some((fact) => fact.observationId === later.observationId) ||
          !(await this.#observations.currentEvidence(later)))
        return { conclusion: 'unresolved', reason: 'EVIDENCE_STALE' };
      let evaluated: boolean;
      if (comparison.kind === 'transition') {
        const earlier = records[0]!;
        const prior = this.#history.find((entry) => entry.observation.observationId === earlier.observationId);
        if (!prior || prior.actionOrdinal >= this.#actionOrdinal || earlier.status !== 'complete' ||
            earlier.result.kind !== 'matches' || later.status !== 'complete' || later.result.kind !== 'matches' ||
            earlier.request.kind !== 'semantic_query' || later.request.kind !== 'semantic_query' ||
            !same(earlier.request.query, later.request.query) || !queryMatchesGoal(goal, later.request) ||
            earlier.explorationAttemptId !== later.explorationAttemptId ||
            earlier.sessionId !== later.sessionId || earlier.pageId !== later.pageId ||
            earlier.stateEpoch >= later.stateEpoch)
          return { conclusion: 'unresolved', reason: 'TEMPORAL_EVIDENCE_MISSING' };
        evaluated = comparison.operator === 'disappears'
          ? earlier.result.count > 0 && later.result.count === 0
          : earlier.result.count === 0 && later.result.count > 0;
      } else {
        const fact = later;
        if (fact.status !== 'complete' || !queryMatchesGoal(goal, fact.request))
          return { conclusion: 'unresolved', reason: 'SUBJECT_NOT_GROUNDED' };
        const result = fact.result;
        if (comparison.kind === 'count') {
          if (result.kind !== 'matches') return { conclusion: 'unresolved', reason: 'TYPE_MISMATCH' };
          evaluated = comparison.operator === 'equal' ? result.count === comparison.expected :
            comparison.operator === 'greater_than' ? result.count > comparison.expected :
              comparison.operator === 'at_least' ? result.count >= comparison.expected : result.count <= comparison.expected;
        } else if (comparison.kind === 'boolean') {
          if (result.kind !== 'property' || result.property !== comparison.property || typeof result.value !== 'boolean')
            return { conclusion: 'unresolved', reason: 'TYPE_MISMATCH' };
          evaluated = result.value === comparison.expected;
        } else {
          if (comparison.property === 'url' ? result.kind !== 'url' :
              result.kind !== 'property' || result.property !== comparison.property || typeof result.value !== 'string')
            return { conclusion: 'unresolved', reason: 'TYPE_MISMATCH' };
          const value = 'value' in result ? String(result.value) : '';
          evaluated = comparison.operator === 'equal' ? value === comparison.expected :
            comparison.operator === 'contains' ? value.includes(comparison.expected) :
              comparison.property === 'url' && comparison.expected.endsWith('/*') &&
              value.startsWith(comparison.expected.slice(0, -1));
        }
      }
      const conclusion = evaluated ? 'satisfied' : 'unsatisfied';
      if (decision.data.conclusion !== conclusion) return { conclusion: 'unresolved', reason: 'CLAIM_CONTRADICTS_FACT' };
      const strategyFacts = records.map((record) => {
        if (record.status !== 'complete' || record.result.kind === 'snapshot') throw new Error('Invalid strategy fact');
        const result = record.result.kind === 'property' ? { kind: 'property' as const,
          property: record.result.property, value: record.result.value, complete: true as const } : record.result;
        return { observationId: record.observationId, request: record.request, result,
          witnessDigest: record.witnessDigest, sessionId: record.sessionId, pageId: record.pageId,
          stateEpoch: record.stateEpoch, mutationEpoch: record.mutationEpoch,
          stateDigest: record.stateDigest, observedAt: record.observedAt, frame: record.frame };
      });
      const data = { strategyVersion: '1', goalStepId: goal.id, observationIds: ids,
        observations: strategyFacts, comparison, evaluated, conclusion,
        testSpecId: later.testSpecId, explorationAttemptId: later.explorationAttemptId,
        sessionId: later.sessionId, pageId: later.pageId, actionOrdinal: this.#actionOrdinal };
      const strategy = parseSuccessfulVerificationStrategyV1({ ...data, strategyDigest: digest(data) });
      this.#journal.push(structuredClone(strategy));
      for (const fact of facts) if (fact.status === 'complete' && fact.result.kind !== 'snapshot' &&
          await this.#observations.currentEvidence(fact))
        this.#history.push({ observation: structuredClone(fact), actionOrdinal: this.#actionOrdinal });
      if (this.#history.length > 32) this.#history.splice(0, this.#history.length - 32);
      return { conclusion, strategy: structuredClone(strategy) };
    }
    return { conclusion: 'unresolved', reason: 'BUDGET_EXHAUSTED' };
  }
}
