import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().min(1).max(16_384);
const short = z.string().min(1).max(1_024);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const url = z.url().max(4_096).refine(value => ['http:', 'https:'].includes(new URL(value).protocol));
const ids = z.array(id).max(100);

export const OperatorConstraintsV1Schema = z.strictObject({
  allowedOrigins: z.array(url).min(1).max(32),
  prohibitedEffects: z.array(short).max(100),
  confirmationRequiredEffects: z.array(short).max(100),
  allowedOperations: z.array(z.enum(['click', 'check', 'uncheck', 'fill', 'select', 'press', 'scroll'])).max(7),
  budgets: z.strictObject({ maxActions: z.number().int().positive(), maxObservations: z.number().int().positive(),
    maxScreenshots: z.number().int().nonnegative() }),
});
export const TaskEnvelopeV1Schema = z.strictObject({
  version: z.literal('1'), taskId: id, authoredInstruction: text, authoredDigest: digest,
  startUrl: url, approvalRef: id, operatorConstraints: OperatorConstraintsV1Schema,
  stateResetRef: id.optional(),
}).refine(value => value.authoredDigest === authoredDigest(value.authoredInstruction),
  { message: 'Authored digest does not match original instruction' })
  .refine(value => value.operatorConstraints.allowedOrigins.some(origin =>
    new URL(origin).origin === new URL(value.startUrl).origin),
  { message: 'Start URL is outside trusted navigation scope' });
export type TaskEnvelopeV1 = z.infer<typeof TaskEnvelopeV1Schema>;
export function authoredDigest(instruction: string): string {
  return createHash('sha256').update(instruction, 'utf8').digest('hex');
}

const authoredGoal = z.strictObject({ goalId: id, kind: z.enum(['required_action', 'outcome', 'assertion', 'constraint']),
  sourceSpan: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  requirement: short, interpretationStatus: z.enum(['literal', 'hypothesis', 'grounded', 'needs_clarification']),
  fulfillment: z.enum(['pending', 'observed_true', 'observed_false', 'unverified']), evidenceRefs: ids });
export const RequirementLedgerV1Schema = z.strictObject({ version: z.literal('1'), taskId: id,
  authoredDigest: digest, authoredGoals: z.array(authoredGoal).max(100),
  inferredPrerequisites: z.array(z.strictObject({ id, description: short, supportsGoalIds: ids })).max(100),
  unresolvedQuestions: z.array(short).max(100) });
export type RequirementLedgerV1 = z.infer<typeof RequirementLedgerV1Schema>;
/** Closed, browser-observable acceptance vocabulary. The model may interpret intent but cannot add executable tests. */
const acceptancePredicate = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('url'), comparison: z.enum(['equals', 'path_equals']), value: short }),
  z.strictObject({ kind: z.literal('element'), role: short, name: short,
    property: z.enum(['exists', 'count', 'visible', 'enabled', 'checked', 'value']),
    equals: z.union([z.boolean(), z.number().int().nonnegative(), z.string().max(1_024)]) })
    .refine(item => item.property === 'count' ? typeof item.equals === 'number' :
      item.property === 'value' ? typeof item.equals === 'string' : typeof item.equals === 'boolean'),
]);
export const RequirementAcceptancePlanV1Schema = z.strictObject({
  version: z.literal('1'), taskId: id, authoredDigest: digest, sourceObservationId: id,
  goals: z.array(z.strictObject({ goalId: id,
    kind: z.enum(['required_action', 'outcome', 'assertion', 'constraint']),
    sourceSpan: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() }),
    requirement: short, status: z.enum(['hypothesis', 'grounded', 'needs_refinement']),
    predicates: z.array(acceptancePredicate).max(10),
    action: z.strictObject({ operation: z.enum(['navigate', 'click', 'check', 'uncheck', 'fill', 'select', 'press', 'scroll']),
      afterGoalIds: ids }).optional(),
    constraint: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('forbid_action'),
        operation: z.enum(['navigate', 'click', 'check', 'uncheck', 'fill', 'select', 'press', 'scroll']),
        target: z.strictObject({ role: short, name: short }).optional() }),
      z.strictObject({ kind: z.literal('required_order'), beforeGoalId: id, afterGoalId: id }),
    ]).optional(),
  })).min(1).max(100),
});
export type RequirementAcceptancePlanV1 = z.infer<typeof RequirementAcceptancePlanV1Schema>;
export type AcceptancePredicateV1 = z.infer<typeof acceptancePredicate>;
export function validateRequirementLedger(envelope: TaskEnvelopeV1,
  input: unknown): RequirementLedgerV1 {
  const ledger = RequirementLedgerV1Schema.parse(input);
  if (ledger.taskId !== envelope.taskId || ledger.authoredDigest !== envelope.authoredDigest ||
      new Set(ledger.authoredGoals.map(goal => goal.goalId)).size !== ledger.authoredGoals.length ||
      ledger.authoredGoals.some(goal => goal.sourceSpan.end <= goal.sourceSpan.start ||
        envelope.authoredInstruction.slice(goal.sourceSpan.start, goal.sourceSpan.end) !== goal.requirement) ||
      ledger.inferredPrerequisites.some(item => item.supportsGoalIds.some(goalId =>
        !ledger.authoredGoals.some(goal => goal.goalId === goalId))))
    throw new Error('INVALID_REQUIREMENT_LEDGER');
  return ledger;
}
/** Apply model-derived interpretation without allowing it to rewrite or remove authored obligations. */
export function validateLedgerUpdate(envelope: TaskEnvelopeV1, previous: RequirementLedgerV1,
  candidate: unknown, trustedEvidenceRefs: ReadonlySet<string> = new Set()): RequirementLedgerV1 {
  validateRequirementLedger(envelope, previous);
  const next = validateRequirementLedger(envelope, candidate);
  if (next.taskId !== envelope.taskId || next.authoredDigest !== envelope.authoredDigest ||
      previous.taskId !== envelope.taskId || previous.authoredDigest !== envelope.authoredDigest ||
      next.authoredGoals.length !== previous.authoredGoals.length) throw new Error('AUTHORED_GOALS_CHANGED');
  for (const prior of previous.authoredGoals) {
    const goal = next.authoredGoals.find(item => item.goalId === prior.goalId);
    if (!goal || goal.kind !== prior.kind || goal.requirement !== prior.requirement ||
        goal.sourceSpan.start !== prior.sourceSpan.start || goal.sourceSpan.end !== prior.sourceSpan.end ||
        envelope.authoredInstruction.slice(goal.sourceSpan.start, goal.sourceSpan.end) !== goal.requirement)
      throw new Error('AUTHORED_GOALS_CHANGED');
    if ((goal.fulfillment === 'observed_true' || goal.fulfillment === 'observed_false' ||
        goal.interpretationStatus === 'grounded') &&
        !goal.evidenceRefs.some(ref => trustedEvidenceRefs.has(ref)))
      throw new Error('UNTRUSTED_GOAL_EVIDENCE');
  }
  if (new Set(next.authoredGoals.map(goal => goal.goalId)).size !== next.authoredGoals.length ||
      next.inferredPrerequisites.some(item => item.supportsGoalIds.some(goalId =>
        !next.authoredGoals.some(goal => goal.goalId === goalId)))) throw new Error('INVALID_GOAL_REFERENCE');
  return next;
}

const viewport = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(),
  scale: z.number().positive() });
const bounds = z.strictObject({ x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive(), height: z.number().positive() });
const visualKind = z.enum(['svg_icon', 'image', 'canvas', 'other']);
const viewportRegion = z.enum(['top_left', 'top_center', 'top_right', 'middle_left',
  'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right']);
export const ObservationV1Schema = z.strictObject({
  version: z.literal('1'), observationId: id, sessionId: id, pageId: id, documentRevision: id,
  coordinateFrameId: id,
  url, observedAt: z.iso.datetime(), viewport,
  accessibility: z.strictObject({ snapshotRef: id, summary: z.string().max(16_384) }),
  dom: z.strictObject({ factsRef: id, summary: z.string().max(16_384), complete: z.boolean().optional(),
    elements: z.array(z.strictObject({ ref: id, role: short.optional(), name: short.optional(),
      selector: short.optional(), checked: z.boolean().optional(), enabled: z.boolean().optional(),
      value: z.string().max(1_024).optional(), valuePresent: z.boolean().optional(),
      inputType: z.string().max(100).optional(),
      range: z.strictObject({ min: z.number().finite(), max: z.number().finite(),
        step: z.union([z.number().positive(), z.literal('any')]),
        value: z.number().finite() }).optional(),
      options: z.array(z.strictObject({ label: z.string().max(1_024),
        value: z.string().max(1_024), selected: z.boolean(), disabled: z.boolean() })).max(100).optional(),
      optionsComplete: z.boolean().optional(), bounds: bounds.optional(),
      visual: z.strictObject({ kind: visualKind, context: short,
        signature: digest.optional() }).optional() })).max(500) }),
  screenshot: z.strictObject({ ref: id, sessionId: id, pageId: id, viewport,
    documentRevision: id, coordinateFrameId: id, observedAt: z.iso.datetime(),
    scrollX: z.number().finite(), scrollY: z.number().finite() }).optional(),
});
export type ObservationV1 = z.infer<typeof ObservationV1Schema>;

const refTarget = z.strictObject({ kind: z.literal('element_ref'), ref: id });
const semanticTarget = z.strictObject({ kind: z.literal('role_name'), role: short, name: short });
const structuralTarget = z.strictObject({ kind: z.literal('structural'), selector: short });
const visualTarget = z.strictObject({ kind: z.literal('visual_coordinate'), screenshotRef: id,
  coordinateFrameId: id, viewport, x: z.number().finite(), y: z.number().finite(),
  description: short, context: short });
export const TargetHypothesisV1Schema = z.discriminatedUnion('kind',
  [refTarget, semanticTarget, structuralTarget, visualTarget]);
export type TargetHypothesisV1 = z.infer<typeof TargetHypothesisV1Schema>;
const base = { version: z.literal('1'), proposalId: id };
const observedBase = { ...base, observationId: id };
const elementAction = { ...observedBase, goalId: id, target: TargetHypothesisV1Schema,
  predictedEffect: short };
const interaction = z.discriminatedUnion('operation', [
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('click') }),
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('check') }),
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('uncheck') }),
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('fill'), value: short }),
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('select'), value: short }),
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('press'), key: short }),
  z.strictObject({ ...elementAction, kind: z.literal('interact'), operation: z.literal('scroll'),
    direction: z.enum(['up', 'down']), pixels: z.number().int().positive().max(2_000) }),
]);
export const AgentProposalV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...observedBase, kind: z.literal('observe'), goalId: id.optional(),
    scope: z.enum(['page', 'region', 'element']), modality: z.enum(['accessibility', 'dom', 'screenshot']) }),
  interaction,
  z.strictObject({ ...observedBase, kind: z.literal('navigate'), goalId: id.optional(),
    url, predictedEffect: short }),
  z.strictObject({ ...observedBase, kind: z.literal('verify'), goalId: id,
    predicate: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('url'), equals: url }),
      z.strictObject({ kind: z.literal('element_state'), target: TargetHypothesisV1Schema,
        property: z.enum(['visible', 'enabled', 'checked', 'value']), equals: z.union([z.boolean(), short]) }),
      z.strictObject({ kind: z.literal('visual'), description: short, screenshotRef: id }),
    ]) }),
  z.strictObject({ ...base, kind: z.literal('request_clarification'), question: short, blockingGoalIds: ids }),
  z.strictObject({ ...base, kind: z.literal('finish_exploration'), unresolvedGoalIds: ids }),
]);
export type AgentProposalV1 = z.infer<typeof AgentProposalV1Schema>;

const reusableTarget = z.discriminatedUnion('kind', [
  semanticTarget, structuralTarget,
  z.strictObject({ kind: z.literal('visual_anchor'), description: short, context: short,
    observedRole: short.optional(), visualKind: visualKind.optional(),
    visualSignature: digest.optional(), viewportRegion: viewportRegion.optional() }),
]);
export const ActionEvidenceV1Schema = z.strictObject({ version: z.literal('1'), evidenceId: id,
  proposalId: id, goalId: id, operation: z.enum(['navigate', 'click', 'check', 'uncheck', 'fill', 'select', 'press', 'scroll']),
  sourceObservationId: id, validatedTarget: short,
  targetWitness: z.strictObject({ observationId: id,
    target: z.discriminatedUnion('kind', [TargetHypothesisV1Schema,
      z.strictObject({ kind: z.literal('navigation'), url })]) }).optional(),
  beforeUrl: url, beforeDocumentRevision: id, afterUrl: url.optional(),
  afterDocumentRevision: id.optional(),
  demonstratedTargets: z.array(reusableTarget).max(5),
  delivery: z.enum(['returned', 'failed', 'unknown']), afterObservationId: id.optional(),
  observedEffect: short.optional(), stopReason: short.optional() });
export type ActionEvidenceV1 = z.infer<typeof ActionEvidenceV1Schema>;
export const ExplorationTraceV1Schema = z.strictObject({ version: z.literal('1'), taskId: id,
  authoredDigest: digest, runId: id, observationIds: ids,
  proposals: z.array(AgentProposalV1Schema).max(500),
  actions: z.array(ActionEvidenceV1Schema).max(500), unresolvedGoalIds: ids })
  .refine(trace => trace.actions.every(action => trace.observationIds.includes(action.sourceObservationId) &&
    trace.proposals.some(proposal => (proposal.kind === 'interact' || proposal.kind === 'navigate') &&
      proposal.proposalId === action.proposalId && proposal.goalId === action.goalId &&
      (proposal.kind === 'navigate' ? action.operation === 'navigate' : proposal.operation === action.operation) &&
      proposal.observationId === action.sourceObservationId)),
  { message: 'Action evidence has no validated interaction proposal' });
export type ExplorationTraceV1 = z.infer<typeof ExplorationTraceV1Schema>;

export const LearnedProcedureV1Schema = z.strictObject({ version: z.literal('1'), procedureId: id,
  taskId: id, authoredDigest: digest, explorationRunId: id,
  initialState: z.strictObject({ expectedUrl: url, resetRef: id.optional(), preconditions: z.array(short).max(50) }),
  steps: z.array(z.strictObject({ stepId: id, goalIds: ids.min(1),
    operation: z.enum(['navigate', 'click', 'check', 'uncheck', 'fill', 'select', 'press', 'scroll']),
    value: short.optional(), expectedTransition: short,
    destinationUrl: url.optional(), navigationEvidenceId: id.optional(),
    targetStrategies: z.array(z.strictObject({ target: reusableTarget,
      status: z.enum(['demonstrated', 'speculative']), evidenceId: id.optional() })).max(5),
    riskClass: z.enum(['read', 'reversible', 'state_changing', 'irreversible']) })).max(100),
  finalGoalIds: ids, knownLimitations: z.array(short).max(100),
  discoveryConfidence: z.enum(['demonstrated', 'partial']) });
export type LearnedProcedureV1 = z.infer<typeof LearnedProcedureV1Schema>;
export function validateLearnedProcedure(input: unknown, trace: ExplorationTraceV1,
  ledger: RequirementLedgerV1, task: TaskEnvelopeV1): LearnedProcedureV1 {
  const procedure = LearnedProcedureV1Schema.parse(input);
  if (procedure.taskId !== trace.taskId || procedure.authoredDigest !== trace.authoredDigest ||
      procedure.explorationRunId !== trace.runId || procedure.taskId !== ledger.taskId ||
      procedure.taskId !== task.taskId || procedure.authoredDigest !== task.authoredDigest ||
      procedure.initialState.expectedUrl !== task.startUrl ||
      procedure.initialState.resetRef !== task.stateResetRef ||
      procedure.finalGoalIds.some(goalId => !ledger.authoredGoals.some(goal => goal.goalId === goalId)))
    throw new Error('PROCEDURE_SOURCE_MISMATCH');
  for (const step of procedure.steps) {
    if (step.goalIds.some(goalId => !ledger.authoredGoals.some(goal => goal.goalId === goalId)))
      throw new Error('PROCEDURE_NOT_DEMONSTRATED');
    if (step.operation === 'navigate') {
      const evidence = trace.actions.find(action => action.evidenceId === step.navigationEvidenceId);
      if (!step.destinationUrl || step.targetStrategies.length || !evidence ||
          evidence.operation !== 'navigate' || evidence.validatedTarget !== step.destinationUrl ||
          evidence.delivery !== 'returned' || !evidence.afterObservationId || !evidence.observedEffect ||
          !step.goalIds.includes(evidence.goalId)) throw new Error('PROCEDURE_NOT_DEMONSTRATED');
    } else if (!step.targetStrategies.some(strategy => strategy.status === 'demonstrated') ||
        step.navigationEvidenceId || step.destinationUrl) throw new Error('PROCEDURE_NOT_DEMONSTRATED');
    for (const strategy of step.targetStrategies) {
      const evidence = trace.actions.find(action => action.evidenceId === strategy.evidenceId);
      if (strategy.status === 'demonstrated' && (!evidence || evidence.delivery !== 'returned' ||
          !step.goalIds.includes(evidence.goalId) || evidence.operation !== step.operation ||
          !evidence.afterObservationId || !evidence.observedEffect ||
          !trace.observationIds.includes(evidence.sourceObservationId) ||
          !trace.observationIds.includes(evidence.afterObservationId) ||
          !evidence.demonstratedTargets.some(target => JSON.stringify(target) === JSON.stringify(strategy.target))) ||
          strategy.status === 'speculative' && strategy.evidenceId)
        throw new Error('PROCEDURE_NOT_DEMONSTRATED');
    }
  }
  return procedure;
}

export const CleanExecutionResultV1Schema = z.strictObject({ version: z.literal('1'), taskId: id,
  authoredDigest: digest, procedureId: id, cleanSessionId: id,
  cleanStart: z.strictObject({ freshBrowserContext: z.boolean(), applicationStateVerified: z.boolean(),
    resetRef: id.optional(), evidenceRef: id.optional() }),
  executionMode: z.enum(['procedural', 'adaptive']), adapted: z.boolean(),
  verificationStrength: z.enum(['deterministic', 'multimodal_review', 'mixed']),
  requirementCoverage: z.array(z.strictObject({ goalId: id,
    status: z.enum(['verified_true', 'verified_false', 'inconclusive', 'blocked']),
    evidenceRef: id.optional() })).max(100),
  actionEvidenceIds: ids, adaptations: z.array(short).max(100), cleanupVerified: z.boolean(),
  outcome: z.enum(['VERIFIED_PASS', 'VERIFIED_FAIL', 'INCONCLUSIVE', 'BLOCKED', 'ENVIRONMENT_FAILED']) });
export type CleanExecutionResultV1 = z.infer<typeof CleanExecutionResultV1Schema>;
/** Trusted verification refs are issued by the independent verifier, never the reasoning model. */
export function validateCleanExecutionResult(input: unknown, ledger: RequirementLedgerV1,
  trustedVerificationRefs: ReadonlySet<string>): CleanExecutionResultV1 {
  const result = CleanExecutionResultV1Schema.parse(input);
  if (result.taskId !== ledger.taskId || result.authoredDigest !== ledger.authoredDigest ||
      new Set(result.requirementCoverage.map(item => item.goalId)).size !== result.requirementCoverage.length ||
      result.requirementCoverage.some(item => !ledger.authoredGoals.some(goal => goal.goalId === item.goalId)))
    throw new Error('RESULT_SOURCE_MISMATCH');
  if (result.outcome === 'VERIFIED_FAIL' && (!result.cleanStart.applicationStateVerified ||
      !result.cleanStart.evidenceRef || !trustedVerificationRefs.has(result.cleanStart.evidenceRef) ||
      !result.requirementCoverage.some(item => item.status === 'verified_false' &&
        !!item.evidenceRef && trustedVerificationRefs.has(item.evidenceRef))))
    throw new Error('UNVERIFIED_FAILURE');
  if (result.outcome === 'VERIFIED_PASS' && (!result.cleanStart.freshBrowserContext ||
      !result.cleanStart.applicationStateVerified || !result.cleanStart.evidenceRef ||
      !trustedVerificationRefs.has(result.cleanStart.evidenceRef) || !result.cleanupVerified ||
      ledger.authoredGoals.some(goal => !result.requirementCoverage.some(item =>
        item.goalId === goal.goalId && item.status === 'verified_true' &&
        !!item.evidenceRef && trustedVerificationRefs.has(item.evidenceRef)))))
    throw new Error('UNVERIFIED_SUCCESS');
  return result;
}
