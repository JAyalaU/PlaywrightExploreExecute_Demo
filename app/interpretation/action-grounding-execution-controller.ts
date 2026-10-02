import { prepareActionGoalGroundingV1, type ActionGroundingModelV5, type IndependentGroundingModelV1,
  type ActionGroundingOutcomeV1 } from './action-grounding-controller.js';
import type { TrustedSemanticAdmissionV2 } from '../domain/action-semantic-admission.js';
import type { ActionCandidateGroundingSessionV1 } from '../exploration/action-candidate-grounding.js';
import { ActionCandidateGroundingError } from '../exploration/action-candidate-grounding.js';
import type { ActionGroundingExecutionOutcomeV1 } from '../domain/action-grounding-execution.js';
import type { ActionExecutionAttemptV1, ActionGroundingWitnessV1 } from '../domain/action-grounding-execution.js';

export const ACTION_GROUNDING_EXECUTION_LIMITS = Object.freeze({ attempts: 3, elapsedMs: 45_000 });
type Runtime = Pick<ActionCandidateGroundingSessionV1, 'query' | 'prepareGrounding' | 'protectedPreparedGrounding' |
  'executePreparedGrounding' | 'protectedActionExecution' | 'protectedActionGroundingWitness'>;
export type ActionGoalExecutionOutcomeV1 =
  | { status: 'succeeded'; witness: ActionGroundingWitnessV1; executionAttempts: ActionExecutionAttemptV1[] }
  | { status: 'stop'; reason: string; category: Exclude<ActionGroundingOutcomeV1, { status: 'prepared' }>['category'];
      executionAttempts: ActionExecutionAttemptV1[];
      diagnostic?: Exclude<ActionGroundingOutcomeV1, { status: 'prepared' }>['diagnostic'] };
function category(reason: string): Exclude<ActionGroundingOutcomeV1, { status: 'prepared' }>['category'] {
  if (['INVALID_REQUEST', 'OBLIGATION_MAPPING_MISMATCH', 'UNTRUSTED_EVIDENCE'].includes(reason)) return 'structural';
  if (['UNSUPPORTED_OPERATION', 'UNSUPPORTED_CONTROL', 'UNSUPPORTED_MAPPING', 'PENDING_OBLIGATIONS'].includes(reason)) return 'unsupported';
  if (['NO_CANDIDATES', 'NON_UNIQUE', 'OPTION_ABSENT', 'OPTION_NON_UNIQUE', 'VALUE_NON_UNIQUE', 'OPTION_DISABLED', 'NOT_ACTIONABLE'].includes(reason)) return 'unresolved';
  return 'provider_environment';
}
/** Retry only rejected pre-action drift. Every retry repeats source correspondence and a complete query.
 * Attempted mutations, including partial/unknown failures, are never automatically repeated. */
export async function executeActionGoalGroundingV1(input: { admission: TrustedSemanticAdmissionV2; goalId: string;
  model: ActionGroundingModelV5; independentModel: IndependentGroundingModelV1; runtime: Runtime;
  aroundFirstDecision?: (prepare: () => Promise<ActionGroundingOutcomeV1>) => Promise<ActionGroundingOutcomeV1> }): Promise<ActionGoalExecutionOutcomeV1> {
  const deadline = Date.now() + ACTION_GROUNDING_EXECUTION_LIMITS.elapsedMs, executionAttempts: ActionExecutionAttemptV1[] = [];
  for (let attempt = 0; attempt < ACTION_GROUNDING_EXECUTION_LIMITS.attempts; attempt++) {
    if (Date.now() >= deadline) return { status: 'stop', reason: 'EXECUTION_BUDGET', category: 'provider_environment', executionAttempts };
    // The optional diagnostic wraps only first preparation, before mutation or execution retries.
    const prepare = () => prepareActionGoalGroundingV1({ ...input, deadline });
    const prepared = attempt === 0 && input.aroundFirstDecision ? await input.aroundFirstDecision(prepare) : await prepare();
    if (prepared.status === 'stop') return { ...prepared, executionAttempts };
    if (Date.now() >= deadline) return { status: 'stop', reason: 'EXECUTION_BUDGET', category: 'provider_environment', executionAttempts };
    let result: ActionGroundingExecutionOutcomeV1;
    try { result = await input.runtime.executePreparedGrounding(prepared.strategy, deadline); }
    catch (error) {
      // BUSY is raised at the lease/entry boundary, before dispatch. Other thrown errors have no retry authority.
      if (error instanceof ActionCandidateGroundingError && error.reason === 'BUSY') continue;
      return { status: 'stop', reason: error instanceof ActionCandidateGroundingError ? error.reason : 'EXECUTION_ENVIRONMENT_STOP',
        category: error instanceof ActionCandidateGroundingError && error.reason === 'UNTRUSTED_EVIDENCE' ? 'structural' : 'provider_environment', executionAttempts };
    }
    executionAttempts.push(result.execution);
    try {
      if (JSON.stringify(input.runtime.protectedActionExecution(result.execution.executionId)) !== JSON.stringify(result.execution))
        return { status: 'stop', reason: 'UNTRUSTED_EVIDENCE', category: 'structural', executionAttempts };
      if (result.status === 'succeeded') {
        if (JSON.stringify(input.runtime.protectedActionGroundingWitness(result.witness.witnessId)) !== JSON.stringify(result.witness))
          return { status: 'stop', reason: 'UNTRUSTED_EVIDENCE', category: 'structural', executionAttempts };
        return { status: 'succeeded', witness: result.witness, executionAttempts };
      }
    } catch {
      return { status: 'stop', reason: 'PROTECTED_READBACK_UNAVAILABLE', category: 'provider_environment', executionAttempts };
    }
    if (result.execution.attempted) return { status: 'stop', reason: result.execution.reason, category: 'provider_environment', executionAttempts };
    if (!['STALE_STATE', 'QUERY_UNEVALUABLE', 'BUSY'].includes(result.execution.reason)) return {
      status: 'stop', reason: result.execution.reason,
      category: category(result.execution.reason), executionAttempts };
  }
  return { status: 'stop', reason: 'EXECUTION_RETRY_EXHAUSTED', category: 'provider_environment', executionAttempts };
}
