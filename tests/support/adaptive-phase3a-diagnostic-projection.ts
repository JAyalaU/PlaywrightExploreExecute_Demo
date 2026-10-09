import { ZodError } from 'zod';
import type { ReasoningModel } from '../../app/adaptive/interfaces.js';
import type { AdaptiveDiagnosticV1 } from '../../app/adaptive/vertical-slice.js';

export const adaptivePhase3aDiagnosticsEnabled = (value: string | undefined) => value === '1';

type Stage = 'intake' | 'refinement' | 'proposal' | 'clean_visual';
type CallOutcome = 'returned' | 'schema_rejected' | 'request_failed';
export interface DiagnosticModelCall {
  stage: Stage;
  observationId: string;
  outcome: CallOutcome;
  feedbackCount: number;
  feedbackProposalIds: string[];
  issues: Array<{ path: string; code: string }>;
}

const pathKeys = new Set(['ledger', 'acceptancePlan', 'authoredGoals', 'goals', 'predicates',
  'predicate', 'kind', 'comparison', 'value', 'equals', 'target', 'property', 'role',
  'name', 'action', 'status', 'goalId', 'sourceSpan', 'observationId']);
const issueCodes = new Set(['invalid_type', 'invalid_union', 'invalid_value',
  'unrecognized_keys', 'too_small', 'too_big', 'invalid_format', 'custom']);

function classifyError(error: unknown): Pick<DiagnosticModelCall, 'outcome' | 'issues'> {
  if (error instanceof ZodError) return { outcome: 'schema_rejected',
    issues: error.issues.slice(0, 8).map(issue => ({
      path: issue.path.slice(0, 6).map(part => typeof part === 'number' ? '#'
        : pathKeys.has(String(part)) ? String(part) : '?').join('.'),
      code: issueCodes.has(issue.code) ? issue.code : 'other',
    })) };
  if (error instanceof SyntaxError) return { outcome: 'schema_rejected', issues: [] };
  return { outcome: 'request_failed', issues: [] };
}

/** Test-harness wrapper: records delivery metadata, never model output or browser content. */
export function diagnosticReasoningModel(model: ReasoningModel) {
  const calls: DiagnosticModelCall[] = [];
  const record = (call: DiagnosticModelCall) => { if (calls.length < 32) calls.push(call); };
  const wrapped: ReasoningModel = {
    async interpretRequirements(context) {
      const base = { stage: context.previous ? 'refinement' as const : 'intake' as const,
        observationId: context.observation.observationId,
        feedbackCount: 0, feedbackProposalIds: [] as string[] };
      try {
        const intake = await model.interpretRequirements(context);
        record({ ...base, outcome: 'returned', issues: [] });
        return intake;
      } catch (error) {
        record({ ...base, ...classifyError(error) });
        throw error;
      }
    },
    async propose(context) {
      const feedback = context.verificationFeedback?.slice(-4) ?? [];
      const base = { stage: context.cleanVisualTarget ? 'clean_visual' as const : 'proposal' as const,
        observationId: context.observation.observationId,
        feedbackCount: feedback.length,
        feedbackProposalIds: feedback.map(item => item.proposalId) };
      try {
        const proposal = await model.propose(context);
        record({ ...base, outcome: 'returned', issues: [] });
        return proposal;
      } catch (error) {
        record({ ...base, ...classifyError(error) });
        throw error;
      }
    },
  };
  return { model: wrapped, calls };
}

const closedStops = new Set(['ACCEPTANCE_NOT_GROUNDED', 'REQUIREMENT_INTAKE_INVALID',
  'REPEATED_INEFFECTIVE_VERIFICATION', 'REPEATED_INEFFECTIVE_ACTION',
  'MODEL_TURN_BUDGET_EXCEEDED', 'TIME_BUDGET_EXCEEDED', 'CLARIFICATION_REQUIRED',
  'ACCEPTANCE_UNRESOLVED', 'EXPLORATION_UNVERIFIED', 'CLEANUP_FAILED']);
const intakeValidationStops = new Set(['ACCEPTANCE_NOT_GROUNDED', 'REQUIREMENT_INTAKE_INVALID',
  'GROUNDED_ACCEPTANCE_CHANGED', 'AUTHORED_GOALS_CHANGED', 'MODEL_GOAL_SELF_REPORT']);

export function projectHeldoutDiagnostics(input: { stopReason?: string;
  outcome: 'VERIFIED_PASS' | 'VERIFIED_FAIL' | 'INCONCLUSIVE' | 'BLOCKED' | 'ENVIRONMENT_FAILED';
  diagnostics?: AdaptiveDiagnosticV1; calls: readonly DiagnosticModelCall[] }) {
  const lastFailure = [...input.calls].reverse().find(call => call.outcome !== 'returned');
  const lastReturnedIntake = [...input.calls].reverse().find(call => call.outcome === 'returned' &&
    (call.stage === 'intake' || call.stage === 'refinement'));
  const validationCode = input.stopReason && intakeValidationStops.has(input.stopReason) &&
    lastReturnedIntake ? input.stopReason : undefined;
  const terminalCategory = lastFailure ? `${lastFailure.stage}_${lastFailure.outcome}` :
    validationCode ? `${lastReturnedIntake!.stage}_validation_rejected` :
    input.stopReason && closedStops.has(input.stopReason) ? input.stopReason :
      input.outcome === 'VERIFIED_PASS' ? 'none' :
        input.outcome === 'BLOCKED' ? 'controller_blocked' :
          input.outcome === 'ENVIRONMENT_FAILED' ? 'environment_failed' : 'completed';
  const diagnostics = input.diagnostics ? { ...input.diagnostics,
    ...(input.diagnostics.firstTerminalFailure ? { firstTerminalFailure: terminalCategory } : {}) } : undefined;
  const requiredActionReceipts = diagnostics?.requirements.filter(goal => goal.kind === 'required_action')
    .map(goal => ({ goalId: goal.goalId,
      actionRecorded: diagnostics.actions.some(action => action.goalId === goal.goalId) })) ?? [];
  return { terminalCategory, ...(validationCode ? { validationCode } : {}),
    diagnostics, modelCalls: input.calls.slice(0, 32), requiredActionReceipts };
}
