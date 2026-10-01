import { ActionGroundingDecisionV5Schema, IndependentGroundingExtractionV1Schema, admitGroundingMappingV1,
  correspondenceNeedsEndorsement, validateGroundingCorrespondenceV1, GroundingCorrespondenceError, type PreparedActionGroundingV1 } from '../domain/action-grounding-strategy.js';
import { buildActionObligationHandoffV2, requireTrustedSemanticAdmissionV2, type TrustedSemanticAdmissionV2 } from '../domain/action-semantic-admission.js';
import { ActionCandidateRequestV1Schema, type ActionCandidateObservationV1 } from '../domain/action-candidate-grounding.js';
import { ActionCandidateGroundingError, type ActionCandidateGroundingSessionV1 } from '../exploration/action-candidate-grounding.js';
import { z } from 'zod';

export const ACTION_GROUNDING_STRATEGY_LIMITS = Object.freeze({ attempts: 3, elapsedMs: 45_000, modelMs: 8_000,
  responseChars: 65_536, inputChars: 65_536 });
export const ACTION_GROUNDING_MAPPING_VOCABULARY = Object.freeze({ vocabularyVersion: '1',
  mappings: Object.freeze(['effect', 'operation', 'literal', 'unique', 'role_exact', 'role_semantic', 'name_exact', 'label', 'pending']),
  operations: Object.freeze(['click', 'fill', 'select_option']),
  instruction: 'Preserve every accepted obligation exactly. Return only the closed source-obligation correspondence contract. Infer a reviewed role or owned label predicate only from authored meaning. Unsupported relationships, exclusions, references and prerequisites remain pending. A literal choice is never a target name. No browser discovery changes source meaning.' });
export const ACTION_GROUNDING_PRIMARY_INSTRUCTION = 'Propose one ActionGoal grounding decision using the supplied closed output contract and reviewed mapping vocabulary. Preserve the admitted source obligations without edits or omissions. Choose a compatible reviewed operation only within the admitted effect/mechanism policy. Return ground or a typed stop; never execute or assert browser facts.';
export const ACTION_GROUNDING_INDEPENDENT_INSTRUCTION = 'Independently extract the complete source-to-reviewed-predicate correspondence using the original authored source, admitted obligations, closed output contract and reviewed vocabulary. No incumbent strategy or browser evidence is supplied. Preserve unsupported material as pending. This is a source interpretation, not an approval flag. Return mappingExtractionVersion 1.';
const primaryOutputContract = z.toJSONSchema(ActionGroundingDecisionV5Schema);
const independentOutputContract = z.toJSONSchema(IndependentGroundingExtractionV1Schema);
export interface ActionGroundingModelV5 {
  complete(input: { context: unknown; signal: AbortSignal }): Promise<string>;
}
export interface IndependentGroundingModelV1 {
  extract(input: { context: unknown; signal: AbortSignal }): Promise<string>;
}
export type ActionGroundingOutcomeV1 =
  | { status: 'prepared'; strategy: PreparedActionGroundingV1; attempts: number }
  | { status: 'stop'; category: 'structural' | 'semantic_disagreement' | 'unsupported' | 'unresolved' | 'provider_environment';
      reason: string; attempts: number };
type GroundingRuntime = Pick<ActionCandidateGroundingSessionV1, 'query' | 'prepareGrounding' | 'protectedPreparedGrounding'>;
async function bounded(call: (signal: AbortSignal) => Promise<string>, deadline: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([call(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_TIMEOUT')); }, Math.max(1, Math.min(ACTION_GROUNDING_STRATEGY_LIMITS.modelMs, deadline - Date.now())));
    })]);
    if (raw.length > ACTION_GROUNDING_STRATEGY_LIMITS.responseChars) throw new GroundingCorrespondenceError('OBLIGATION_MAPPING_MISMATCH');
    try { return JSON.parse(raw); } catch { throw new GroundingCorrespondenceError('OBLIGATION_MAPPING_MISMATCH'); }
  } finally { clearTimeout(timer); }
}
/** An isolated preparation route: no browser action, production selection, fallback or old-format upgrade. */
export async function prepareActionGoalGroundingV1(input: { admission: TrustedSemanticAdmissionV2; goalId: string;
  model: ActionGroundingModelV5; independentModel: IndependentGroundingModelV1; runtime: GroundingRuntime; deadline?: number }): Promise<ActionGroundingOutcomeV1> {
  requireTrustedSemanticAdmissionV2(input.admission);
  const goal = input.admission.spec.steps.find((s) => s.id === input.goalId);
  if (!goal || goal.type !== 'action_goal') return { status: 'stop', category: 'structural', reason: 'INVALID_GOAL', attempts: 0 };
  const deadline = Math.min(Date.now() + ACTION_GROUNDING_STRATEGY_LIMITS.elapsedMs, input.deadline ?? Number.POSITIVE_INFINITY);
  const handoff = buildActionObligationHandoffV2(input.admission);
  const sourceContext = { mappingExtractionVersion: '1', sourceInstruction: input.admission.spec.sourceInstruction,
    goal, admissionRecord: input.admission.record, handoff, vocabulary: ACTION_GROUNDING_MAPPING_VOCABULARY };
  let lastReason: string | undefined;
  let priorCandidate: ActionCandidateObservationV1 | undefined;
  for (let attempt = 1; attempt <= ACTION_GROUNDING_STRATEGY_LIMITS.attempts; attempt++) {
    if (Date.now() >= deadline) return { status: 'stop', category: 'provider_environment', reason: 'STRATEGY_TIMEOUT', attempts: attempt - 1 };
    let stage: 'model' | 'contract' | 'runtime' = 'model';
    try {
      const context = { decisionVersion: '5', ...sourceContext, promptVersion: 'wp2d_a_primary_v1',
        instruction: ACTION_GROUNDING_PRIMARY_INSTRUCTION, outputContract: primaryOutputContract, attempt, ...(lastReason ? { lastReason } : {}),
        ...(priorCandidate ? { priorCandidate } : {}) };
      if (JSON.stringify(context).length > ACTION_GROUNDING_STRATEGY_LIMITS.inputChars)
        return { status: 'stop', category: 'structural', reason: 'INPUT_LIMIT', attempts: attempt };
      const raw = await bounded((signal) => input.model.complete({ context: structuredClone(context), signal }), deadline);
      stage = 'contract';
      const decision = ActionGroundingDecisionV5Schema.parse(raw);
      if (decision.kind === 'stop') return { status: 'stop', category: decision.reason, reason: 'MODEL_STOP', attempts: attempt };
      if (decision.goalId !== goal.id) throw new GroundingCorrespondenceError('OBLIGATION_MAPPING_MISMATCH');
      // Validate mechanical source linkage before spending the independent extraction call.
      validateGroundingCorrespondenceV1(input.admission, goal.id, decision.correspondence);
      let independent: unknown;
      if (correspondenceNeedsEndorsement(decision.correspondence)) {
        const independentContext = { ...sourceContext, promptVersion: 'wp2d_a_independent_v1',
          instruction: ACTION_GROUNDING_INDEPENDENT_INSTRUCTION, outputContract: independentOutputContract };
        if (JSON.stringify(independentContext).length > ACTION_GROUNDING_STRATEGY_LIMITS.inputChars)
          return { status: 'stop', category: 'structural', reason: 'INPUT_LIMIT', attempts: attempt };
        stage = 'model';
        // No first decision/correspondence, candidate, prior reason, selected ref, snapshot or browser state.
        independent = await bounded((signal) => input.independentModel.extract({ context: structuredClone(independentContext), signal }), deadline);
        stage = 'contract'; IndependentGroundingExtractionV1Schema.parse(independent);
      }
      const mapping = admitGroundingMappingV1(input.admission, goal.id, decision.correspondence, independent);
      const request = ActionCandidateRequestV1Schema.parse({ groundingVersion: '1', goalId: goal.id, handoff,
        mapping: mapping.correspondence.map(({ obligation: o, realization: r }) => {
          if (['effect', 'operation', 'literal', 'unique'].includes(r.kind)) return { obligationId: o.id, kind: r.kind };
          if (r.kind === 'role_exact') return { obligationId: o.id, kind: r.kind, role: r.role };
          if (r.kind === 'name_exact') return { obligationId: o.id, kind: r.kind, name: r.name };
          return { obligationId: o.id, kind: 'pending' };
        }) });
      if (mapping.correspondence.some((e) => e.realization.kind === 'pending'))
        return { status: 'stop', category: 'unsupported', reason: 'PENDING_OBLIGATIONS', attempts: attempt };
      stage = 'runtime';
      const candidate = await input.runtime.query(request, deadline); priorCandidate = candidate;
      if (candidate.status === 'error') throw new ActionCandidateGroundingError(candidate.reason);
      const strategy = await input.runtime.prepareGrounding(candidate, mapping, decision.operation, deadline);
      if (Date.now() >= deadline) return { status: 'stop', category: 'provider_environment', reason: 'STRATEGY_TIMEOUT', attempts: attempt };
      if (JSON.stringify(input.runtime.protectedPreparedGrounding(strategy.strategyId)) !== JSON.stringify(strategy))
        throw new ActionCandidateGroundingError('UNTRUSTED_EVIDENCE');
      return { status: 'prepared', strategy, attempts: attempt };
    } catch (error) {
      if (error instanceof GroundingCorrespondenceError) return { status: 'stop',
        category: error.reason === 'SEMANTIC_DISAGREEMENT' ? 'semantic_disagreement' : error.reason === 'UNSUPPORTED_MAPPING' ? 'unsupported' : 'structural',
        reason: error.reason, attempts: attempt };
      if (error instanceof ActionCandidateGroundingError) {
        const retryable = ['STALE_STATE', 'QUERY_UNEVALUABLE', 'BUSY'].includes(error.reason);
        if (retryable && attempt < ACTION_GROUNDING_STRATEGY_LIMITS.attempts) { lastReason = error.reason; continue; }
        return { status: 'stop', category: ['NO_CANDIDATES', 'NON_UNIQUE', 'OPTION_ABSENT', 'OPTION_NON_UNIQUE', 'VALUE_NON_UNIQUE', 'OPTION_DISABLED', 'NOT_ACTIONABLE'].includes(error.reason)
          ? 'unresolved' : ['UNSUPPORTED_CONTROL', 'UNSUPPORTED_OPERATION', 'PENDING_OBLIGATIONS', 'UNSUPPORTED_MAPPING'].includes(error.reason)
            ? 'unsupported' : ['INVALID_REQUEST', 'OBLIGATION_MAPPING_MISMATCH', 'UNTRUSTED_EVIDENCE'].includes(error.reason) ? 'structural' : 'provider_environment',
          reason: error.reason, attempts: attempt };
      }
      return { status: 'stop', category: stage === 'contract' ? 'structural' : 'provider_environment',
        reason: stage === 'contract' ? 'INVALID_DECISION' : 'PROVIDER_OR_ENVIRONMENT_STOP', attempts: attempt };
    }
  }
  return { status: 'stop', category: 'provider_environment', reason: 'STRATEGY_BUDGET', attempts: ACTION_GROUNDING_STRATEGY_LIMITS.attempts };
}
