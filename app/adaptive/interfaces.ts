import type { AgentProposalV1, ActionEvidenceV1, ObservationV1, RequirementAcceptancePlanV1, RequirementLedgerV1,
  TaskEnvelopeV1 } from './contracts.js';
import type { RequirementIntakeV1 } from './requirement-acceptance.js';

/** The broker owns browser observations and their short-lived references. */
export interface ObservationBroker {
  observeInitial(task: TaskEnvelopeV1): Promise<ObservationV1>;
  observeCurrent(afterAction?: ActionEvidenceV1): Promise<ObservationV1>;
  observeAccessibility(observationId: string): Promise<ObservationV1>;
  observeDom(observationId: string, focus?: string): Promise<ObservationV1>;
  captureScreenshot(observationId: string, focus?: string): Promise<ObservationV1>;
}

export interface ReasoningContextV1 {
  /** A value snapshot of immutable authored intent; approval and operator policy stay outside model input. */
  readonly original: Readonly<Pick<TaskEnvelopeV1,
    'taskId' | 'authoredInstruction' | 'authoredDigest' | 'startUrl'>>;
  readonly ledger: Readonly<RequirementLedgerV1>;
  readonly acceptancePlan?: Readonly<RequirementAcceptancePlanV1>;
  readonly observation: Readonly<ObservationV1>;
  /** Current browser-owned JPEG bytes; never included in observations or traces. */
  readonly screenshotDataUrl?: string;
  /** A bounded clean-pass re-identification request, not a fresh plan. */
  readonly cleanVisualTarget?: Readonly<{ description: string; context: string;
    expectedTransition: string; goalId: string; operation: 'click' }>;
  readonly validatedHistory: readonly Readonly<{ observation: ObservationV1; action?: ActionEvidenceV1 }>[];
  readonly unresolvedGoalIds: readonly string[];
  /** Controller-derived, bounded verification facts from prior exploration turns. */
  readonly verificationFeedback?: readonly VerificationFeedbackV1[];
  readonly availableOperations: readonly (Extract<AgentProposalV1, { kind: 'interact' }>['operation'] |
    'navigate' | 'observe' | 'verify')[];
  readonly remainingBudgets?: Readonly<{ modelTurns: number; browserActions: number;
    elapsedMs: number }>;
  readonly maxContextCharacters: number;
  /** Optional caller cancellation. The current vertical slice does not yet supply this. */
  readonly signal?: AbortSignal;
}
export interface VerificationFeedbackV1 {
  readonly proposalId: string;
  readonly goalId: string;
  readonly observationId: string;
  readonly predicateIdentity: string;
  readonly observedResult: 'true' | 'false' | 'unknown';
  readonly matchesAcceptance: boolean;
  readonly missingActionEvidence: boolean;
  readonly missingOrderingEvidence: boolean;
  readonly newEvidence: boolean;
  readonly progressBefore: Readonly<{ coverage: 'verified_true' | 'verified_false' | 'inconclusive';
    explicitlyVerified: boolean }>;
  readonly progressAfter: Readonly<{ coverage: 'verified_true' | 'verified_false' | 'inconclusive';
    explicitlyVerified: boolean }>;
  readonly reason: 'advanced' | 'predicate_mismatch' | 'observed_false' | 'observation_unknown' |
    'action_evidence_missing' | 'ordering_evidence_missing' | 'already_verified' | 'repeated_observation';
}
/** Adapters validate raw provider output with AgentProposalV1Schema before returning. */
export interface ReasoningModel {
  /** Interpret authored obligations after seeing the real initial page. No fixture acceptance rules enter this call. */
  interpretRequirements(context: Readonly<{ original: ReasoningContextV1['original'];
    observation: ObservationV1; previous?: RequirementIntakeV1;
    screenshotDataUrl?: string;
    signal?: AbortSignal;
    remainingRefinements: number }>): Promise<RequirementIntakeV1>;
  propose(context: ReasoningContextV1): Promise<AgentProposalV1>;
}

export interface ResetProofV1 {
  readonly freshBrowserContext: boolean;
  readonly applicationStateVerified: boolean;
  readonly resetRef?: string;
  readonly evidenceRef?: string;
}
/** Implementation and reset reference come from trusted configuration, never a proposal. */
export interface StateResetProvider {
  prepareCleanState(task: TaskEnvelopeV1): Promise<ResetProofV1>;
}
