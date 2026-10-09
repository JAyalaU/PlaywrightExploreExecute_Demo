import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ActionEvidenceV1Schema, AgentProposalV1Schema, ExplorationTraceV1Schema, TaskEnvelopeV1Schema,
  validateRequirementLedger, validateCleanExecutionResult,
  validateLearnedProcedure, type ActionEvidenceV1, type AgentProposalV1,
  type CleanExecutionResultV1, type ExplorationTraceV1, type LearnedProcedureV1,
  type ObservationV1, type RequirementLedgerV1, type TaskEnvelopeV1 } from './contracts.js';
import { dispatchValidatedProposal, GatewayRejectionV1, type TrustedGatewayStateV1 } from './action-gateway.js';
import type { ReasoningModel, StateResetProvider, VerificationFeedbackV1 } from './interfaces.js';
import { AdaptiveBrowser, observedViewportRegion } from './browser.js';
import { promoteGroundedAcceptance,
  evaluateAcceptancePredicate, validateRequirementIntake, verifyAcceptedRequirements,
  type RequirementIntakeV1 } from './requirement-acceptance.js';

type Interaction = Extract<AgentProposalV1, { kind: 'interact' }>;
export interface AdaptiveRunOptions {
  task: TaskEnvelopeV1;
  model: ReasoningModel; reset: StateResetProvider; openBrowser: () => Promise<AdaptiveBrowser>;
  maxModelTurns: number; maxElapsedMs: number; maxIneffectiveActions: number;
  /** Trusted monotonic clock seam for deterministic budget tests. */
  now?: () => number;
  /** Include a bounded, safe diagnostic projection in the returned report. */
  diagnostics?: boolean;
}
export interface AdaptiveDiagnosticV1 {
  requirements: Array<{ goalId: string; kind: RequirementLedgerV1['authoredGoals'][number]['kind'];
    status: 'hypothesis' | 'grounded' | 'needs_refinement';
    predicates: Array<{ identity: string; state: 'true' | 'false' | 'unknown' }> }>;
  proposals: Array<{ kind: AgentProposalV1['kind']; goalId?: string; observationId?: string;
    gatewayDecision: 'accepted' | 'rejected'; reason?: string }>;
  actions: Array<{ goalId: string; operation: ActionEvidenceV1['operation'];
    effect: 'url_changed' | 'control_changed' | 'snapshot_changed' | 'none' }>;
  verifications: VerificationFeedbackV1[];
  firstTerminalFailure?: string;
}
export interface AdaptiveRunReport { trace: ExplorationTraceV1; procedure?: LearnedProcedureV1;
  result: CleanExecutionResultV1; observations: ObservationV1[]; explorationActions: ActionEvidenceV1[];
  timingsMs: { exploration: number; cleanReset: number; cleanExecution: number;
    verificationCleanup: number; total: number };
  finalCleanState?: { observationId: string; url: string;
    controls: Array<{ role?: string; name?: string; checked?: boolean }> };
  cleanVisualModelCalls: number;
  cleanVisualReidentifications: Array<{ stepId: string; screenshotRef: string;
    proposalId: string; targetKind: 'element_ref' | 'visual_coordinate';
    x: number; y: number; description: string }>;
  explorationChecks: Array<{ proposalId: string; goalId: string; observationId: string;
    satisfied: boolean; newInformation: boolean }>;
  diagnostics?: AdaptiveDiagnosticV1;
  stopReason?: string }
const newId = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '')}`;
const targetText = (proposal: Interaction) => JSON.stringify(proposal.target).slice(0, 1024);
const targetWitness = (proposal: Extract<AgentProposalV1, { kind: 'interact' | 'navigate' }>) => ({
  observationId: proposal.observationId,
  target: proposal.kind === 'navigate' ? { kind: 'navigation' as const, url: proposal.url } : proposal.target });
const allowed = new Set(['click', 'check', 'uncheck']);
function observedTransition(before: ObservationV1, after: ObservationV1): string | undefined {
  if (before.url !== after.url) {
    const from = new URL(before.url), to = new URL(after.url);
    return `URL ${from.origin}${from.pathname} -> ${to.origin}${to.pathname}`;
  }
  for (const item of after.dom.elements) {
    const prior = before.dom.elements.find(candidate => candidate.role === item.role && candidate.name === item.name);
    if (!prior) return `${item.role ?? 'control'} ${JSON.stringify(item.name ?? '')} appeared`;
    if (prior.checked !== item.checked && item.checked !== undefined)
      return `${item.role ?? 'control'} ${JSON.stringify(item.name ?? '')} checked ${prior.checked} -> ${item.checked}`;
    if (prior.enabled !== item.enabled && item.enabled !== undefined)
      return `${item.role ?? 'control'} ${JSON.stringify(item.name ?? '')} enabled ${prior.enabled} -> ${item.enabled}`;
  }
  for (const item of before.dom.elements) if (!after.dom.elements.some(candidate =>
    candidate.role === item.role && candidate.name === item.name))
    return `${item.role ?? 'control'} ${JSON.stringify(item.name ?? '')} disappeared`;
  if (before.accessibility.summary !== after.accessibility.summary) return 'Accessibility snapshot changed';
  return undefined;
}
function verifyProposal(proposal: Extract<AgentProposalV1, { kind: 'verify' }>,
  before: ObservationV1, observation: ObservationV1): 'true' | 'false' | 'unknown' {
  const predicate = proposal.predicate;
  if (predicate.kind === 'url') return observation.url === predicate.equals ? 'true' : 'false';
  if (predicate.kind !== 'element_state') return 'unknown';
  const target = predicate.target;
  const bound = target.kind === 'element_ref'
    ? before.dom.elements.find(item => item.ref === target.ref)
    : target.kind === 'role_name'
      ? { role: target.role, name: target.name } : undefined;
  if (!bound) return 'unknown';
  const matches = observation.dom.elements.filter(item => item.role === bound.role && item.name === bound.name);
  if (matches.length !== 1) {
    if (matches.length === 0 && observation.dom.complete && predicate.property === 'visible')
      return predicate.equals === false ? 'true' : 'false';
    return 'unknown';
  }
  const item = matches[0]!;
  if (predicate.property === 'visible') {
    if (!item.bounds) return 'unknown';
    const b = item.bounds;
    const visible = b.x < observation.viewport.width && b.y < observation.viewport.height &&
      b.x + b.width > 0 && b.y + b.height > 0;
    return visible === predicate.equals ? 'true' : 'false';
  }
  const actual = predicate.property === 'enabled' ? item.enabled :
    predicate.property === 'checked' ? item.checked : item.value;
  return actual === undefined ? 'unknown' : actual === predicate.equals ? 'true' : 'false';
}
function verificationMatchesAcceptance(proposal: Extract<AgentProposalV1, { kind: 'verify' }>,
  intake: RequirementIntakeV1, before: ObservationV1): boolean {
  const goal = intake.acceptancePlan.goals.find(item => item.goalId === proposal.goalId);
  if (!goal || goal.kind === 'required_action') return false;
  const predicate = proposal.predicate;
  if (predicate.kind === 'url') return goal.predicates.some(item => item.kind === 'url' &&
    (item.comparison === 'equals' ? item.value === predicate.equals :
      new URL(predicate.equals).origin === new URL(before.url).origin &&
      new URL(predicate.equals).pathname === item.value));
  if (predicate.kind !== 'element_state') return false;
  const target = predicate.target;
  const semantic = target.kind === 'role_name' ? target : target.kind === 'element_ref'
    ? before.dom.elements.find(item => item.ref === target.ref) : undefined;
  if (!semantic) return false;
  return goal.predicates.some(item => item.kind === 'element' && item.role === semantic.role &&
    item.name === semantic.name && item.property === predicate.property && item.equals === predicate.equals);
}
function verificationIdentity(proposal: Extract<AgentProposalV1, { kind: 'verify' }>,
  before: ObservationV1): string {
  const predicate = proposal.predicate;
  if (predicate.kind !== 'element_state')
    return safePredicateIdentity(predicate.kind, [proposal.goalId, predicate]);
  const target = predicate.target;
  const semantic = target.kind === 'element_ref'
    ? before.dom.elements.find(item => item.ref === target.ref)
    : target.kind === 'role_name' ? target : undefined;
  return safePredicateIdentity(predicate.kind, [proposal.goalId, predicate.kind,
    semantic?.role, semantic?.name, predicate.property, predicate.equals]);
}
function safePredicateIdentity(kind: string, parts: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
function verificationFingerprint(proposal: Extract<AgentProposalV1, { kind: 'verify' }>,
  before: ObservationV1, observed: 'true' | 'false' | 'unknown', matches: boolean): string {
  return JSON.stringify([verificationIdentity(proposal, before), observed, matches]);
}
function failedEvidence(proposal: Extract<AgentProposalV1, { kind: 'interact' | 'navigate' }>,
  before: ObservationV1, delivery: 'returned' | 'unknown' = 'unknown',
  stopReason = 'BROWSER_ACTION_ERROR'): ActionEvidenceV1 {
  return ActionEvidenceV1Schema.parse({ version: '1', evidenceId: newId('e'),
    proposalId: proposal.proposalId, goalId: proposal.goalId!,
    operation: proposal.kind === 'navigate' ? 'navigate' : proposal.operation,
    sourceObservationId: before.observationId,
    validatedTarget: proposal.kind === 'navigate' ? proposal.url : targetText(proposal),
    beforeUrl: before.url, beforeDocumentRevision: before.documentRevision,
    demonstratedTargets: [], delivery, stopReason });
}

function gatewayState(task: TaskEnvelopeV1, observation: ObservationV1, usedActions: number,
  usedObservations: number, unresolved: ReadonlySet<string>, usedScreenshots = 0): TrustedGatewayStateV1 {
  return { task, currentObservation: observation, binding: { observationId: observation.observationId,
    sessionId: observation.sessionId, pageId: observation.pageId,
    documentRevision: observation.documentRevision, coordinateFrameId: observation.coordinateFrameId,
    ...(observation.screenshot ? { screenshotRef: observation.screenshot.ref,
      scrollX: observation.screenshot.scrollX, scrollY: observation.screenshot.scrollY } : {}) },
    usedActions, usedObservations, usedScreenshots, unresolvedGoalIds: unresolved,
    visualCoordinateDispatchVerified: true,
    authorizedRiskClasses: new Set(['read', 'reversible', 'state_changing']), confirmedEffects: new Set(),
    classifyInteraction: (action, observed) => {
      const target = observed.dom.elements.find(item => action.target.kind === 'element_ref'
        ? item.ref === action.target.ref : action.target.kind === 'role_name'
          ? item.role === action.target.role && item.name === action.target.name : false);
      const label = action.target.kind === 'visual_coordinate'
        ? `${action.target.description} ${action.target.context ?? ''}` : target?.name ?? '';
      const highRisk = /\b(delete|remove|purchase|pay|send|publish)\b/i.test(label);
      return { risk: highRisk ? 'irreversible' : 'state_changing',
        effect: highRisk ? 'irreversible_action' : action.operation };
    } };
}
function persistentTarget(proposal: Interaction, before: ObservationV1, requirement: string) {
  const target = proposal.target;
  const visualElement = target.kind === 'element_ref'
    ? before.dom.elements.find(item => item.ref === target.ref)
    : target.kind === 'visual_coordinate'
      ? before.dom.elements.filter(item => item.bounds &&
        target.x >= item.bounds.x && target.y >= item.bounds.y &&
        target.x < item.bounds.x + item.bounds.width &&
        target.y < item.bounds.y + item.bounds.height)[0] : undefined;
  const visualMetadata = visualElement?.bounds && visualElement.visual ? {
    ...(visualElement.role ? { observedRole: visualElement.role } : {}),
    visualKind: visualElement.visual.kind,
    ...(visualElement.visual.signature ? { visualSignature: visualElement.visual.signature } : {}),
    viewportRegion: observedViewportRegion(visualElement.bounds, before.viewport) } : {};
  if (proposal.target.kind === 'visual_coordinate') return { kind: 'visual_anchor' as const,
    description: proposal.target.description, context: proposal.target.context,
    ...visualMetadata };
  if (proposal.target.kind === 'element_ref' && visualElement && !visualElement.name &&
      visualElement.visual && visualElement.bounds && before.screenshot) {
    const kind = visualElement.visual.kind.replace('_', ' ');
    const region = observedViewportRegion(visualElement.bounds, before.viewport);
    return { kind: 'visual_anchor' as const,
      description: `unnamed ${visualElement.role ?? 'control'} with ${kind} associated with ${requirement}`.slice(0, 1024),
      context: `${visualElement.visual.context}; ${region.replace('_', ' ')} of viewport`.slice(0, 1024),
      ...visualMetadata };
  }
  const match = before.dom.elements.find(item => proposal.target.kind === 'element_ref' &&
    item.ref === proposal.target.ref || proposal.target.kind === 'role_name' &&
    item.role === proposal.target.role && item.name === proposal.target.name);
  return match?.role && match.name ? { kind: 'role_name' as const, role: match.role, name: match.name } : undefined;
}
function result(task: TaskEnvelopeV1, ledger: RequirementLedgerV1, procedureId: string,
  sessionId: string, cleanStart: CleanExecutionResultV1['cleanStart'],
  coverage: CleanExecutionResultV1['requirementCoverage'], trusted: Set<string>,
  actionIds: string[], outcome: CleanExecutionResultV1['outcome'], cleanupVerified: boolean): CleanExecutionResultV1 {
  if (cleanStart.evidenceRef) trusted.add(cleanStart.evidenceRef);
  return validateCleanExecutionResult({ version: '1', taskId: task.taskId,
    authoredDigest: task.authoredDigest, procedureId, cleanSessionId: sessionId,
    cleanStart, executionMode: 'procedural', adapted: false, verificationStrength: 'deterministic',
    requirementCoverage: coverage, actionEvidenceIds: actionIds, adaptations: [], cleanupVerified, outcome },
  ledger, trusted);
}

export async function runAdaptiveVerticalSlice(options: AdaptiveRunOptions): Promise<AdaptiveRunReport> {
  const { task } = options;
  TaskEnvelopeV1Schema.parse(task);
  let ledger: RequirementLedgerV1 = validateRequirementLedger(task, { version: '1', taskId: task.taskId,
    authoredDigest: task.authoredDigest, authoredGoals: [], inferredPrerequisites: [], unresolvedQuestions: [] });
  let intake: RequirementIntakeV1 | undefined;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const timingsMs: AdaptiveRunReport['timingsMs'] = { exploration: 0, cleanReset: 0,
    cleanExecution: 0, verificationCleanup: 0, total: 0 };
  type Phase = Exclude<keyof typeof timingsMs, 'total'>;
  let phase: Phase = 'exploration', phaseStarted = started;
  const enterPhase = (next: Phase) => { const at = now();
    timingsMs[phase] += Math.max(0, at - phaseStarted); phase = next; phaseStarted = at; };
  const remainingTime = () => Math.max(0, options.maxElapsedMs - (now() - started));
  const observations: ObservationV1[] = [], proposals: AgentProposalV1[] = [], actions: ActionEvidenceV1[] = [];
  const explorationChecks: AdaptiveRunReport['explorationChecks'] = [];
  const verificationFeedback: VerificationFeedbackV1[] = [];
  const diagnostics: AdaptiveDiagnosticV1 | undefined = options.diagnostics
    ? { requirements: [], proposals: [], actions: [], verifications: [] } : undefined;
  const traceId = newId('r');
  let exploration: AdaptiveBrowser | undefined, clean: AdaptiveBrowser | undefined;
  let procedure: LearnedProcedureV1 | undefined;
  let cleanSessionId = newId('s');
  let cleanStart: CleanExecutionResultV1['cleanStart'] = { freshBrowserContext: false, applicationStateVerified: false };
  let cleanActions: ActionEvidenceV1[] = [];
  let coverage: CleanExecutionResultV1['requirementCoverage'] = ledger.authoredGoals.map(goal =>
    ({ goalId: goal.goalId, status: 'inconclusive' }));
  let trusted = new Set<string>();
  let outcome: CleanExecutionResultV1['outcome'] = 'BLOCKED';
  let cleanupVerified = false;
  let ineffective = 0;
  let usedScreenshots = 0;
  let cleanVisualModelCalls = 0;
  const cleanVisualReidentifications: AdaptiveRunReport['cleanVisualReidentifications'] = [];
  let finalCleanState: AdaptiveRunReport['finalCleanState'];
  let explored = false;
  const explorationVerified = new Set<string>();
  const checkOutcomes = new Set<string>();
  let stopReason: string | undefined;
  const deadline = () => { if (now() - started > options.maxElapsedMs) throw new Error('TIME_BUDGET_EXCEEDED'); };
  const unresolvedGoals = (current?: ObservationV1) => {
    const evaluated = current && intake ? verifyAcceptedRequirements(intake, observations, actions).coverage : [];
    return new Set(ledger.authoredGoals.filter(goal =>
      evaluated.find(item => item.goalId === goal.goalId)?.status !== 'verified_true' ||
      (goal.kind === 'outcome' || goal.kind === 'assertion') &&
        intake?.acceptancePlan.goals.find(item => item.goalId === goal.goalId)?.predicates.every(item =>
          item.kind === 'url' || !['exists', 'count'].includes(item.property)) &&
        !explorationVerified.has(goal.goalId))
      .map(goal => goal.goalId));
  };
  const makeTrace = (unresolved: ReadonlySet<string>) => ExplorationTraceV1Schema.parse({ version: '1',
    taskId: task.taskId, authoredDigest: task.authoredDigest, runId: traceId,
    observationIds: observations.map(item => item.observationId), proposals, actions,
    unresolvedGoalIds: [...unresolved] });
  const makeProcedure = (trace: ExplorationTraceV1): LearnedProcedureV1 => {
    if (!actions.length || actions.some(action => !action.observedEffect ||
      action.operation !== 'navigate' && !action.demonstratedTargets.length))
      throw new Error('PROCEDURE_NOT_DEMONSTRATED');
    return validateLearnedProcedure({ version: '1', procedureId: newId('proc'),
      taskId: task.taskId, authoredDigest: task.authoredDigest, explorationRunId: traceId,
      initialState: { expectedUrl: task.startUrl, resetRef: task.stateResetRef, preconditions: [] },
      steps: actions.map(action => ({
        stepId: newId('step'), goalIds: [action.goalId], operation: action.operation,
        expectedTransition: action.observedEffect!, targetStrategies: [{ target: action.demonstratedTargets[0],
          status: 'demonstrated', evidenceId: action.evidenceId }].filter(item => !!item.target),
        ...(action.operation === 'navigate' ? { destinationUrl: action.validatedTarget,
          navigationEvidenceId: action.evidenceId } : {}),
        riskClass: action.operation === 'navigate' ? 'read' : 'state_changing' })),
      finalGoalIds: ledger.authoredGoals.map(goal => goal.goalId), knownLimitations: [],
      discoveryConfidence: 'demonstrated' }, trace, ledger, task);
  };
  try {
    const explorationReset = await options.reset.prepareCleanState(task);
    deadline();
    if (!explorationReset.applicationStateVerified) throw new Error('RESET_UNVERIFIED');
    exploration = await options.openBrowser();
    let observation = await exploration.observeInitial(task); observations.push(observation);
    deadline();
    intake = promoteGroundedAcceptance(validateRequirementIntake(task, observation,
      await options.model.interpretRequirements({ original: { taskId: task.taskId,
        authoredInstruction: task.authoredInstruction, authoredDigest: task.authoredDigest,
        startUrl: task.startUrl }, observation: structuredClone(observation), remainingRefinements: 2,
        ...(observation.screenshot ? { screenshotDataUrl: exploration.getScreenshotData(observation.screenshot.ref) } : {}) }),
      observations), observations);
    ledger = intake.ledger;
    coverage = ledger.authoredGoals.map(goal => ({ goalId: goal.goalId, status: 'inconclusive' }));
    deadline();
    let refinements = 0;
    for (let turn = 0; turn < options.maxModelTurns; turn++) {
      deadline();
      const unresolved = unresolvedGoals(observation);
      if (!unresolved.size && !ledger.unresolvedQuestions.length) {
        procedure = makeProcedure(makeTrace(unresolved));
        explored = true;
        break;
      }
      const feedbackSeenThrough = verificationFeedback.length;
      let proposal = await options.model.propose({ original: { taskId: task.taskId,
        authoredInstruction: task.authoredInstruction, authoredDigest: task.authoredDigest,
        startUrl: task.startUrl }, ledger: structuredClone(ledger),
        acceptancePlan: structuredClone(intake!.acceptancePlan), observation: structuredClone(observation),
        validatedHistory: observations.slice(-5).map(item => ({ observation: structuredClone(item),
          ...(actions.find(action => action.afterObservationId === item.observationId)
            ? { action: structuredClone(actions.find(action => action.afterObservationId === item.observationId)!) } : {}) })),
        unresolvedGoalIds: [...unresolved], availableOperations: ['click', 'check', 'uncheck',
          'navigate', 'observe', 'verify'], remainingBudgets: { modelTurns: options.maxModelTurns - turn,
          browserActions: task.operatorConstraints.budgets.maxActions - actions.length,
          elapsedMs: remainingTime() },
        verificationFeedback: verificationFeedback.slice(-4),
        maxContextCharacters: 24_000,
        ...(observation.screenshot ? { screenshotDataUrl: exploration.getScreenshotData(observation.screenshot.ref) } : {}) });
      deadline();
      proposal = AgentProposalV1Schema.parse(proposal);
      proposals.push(proposal);
      if (proposal.kind === 'interact' && !allowed.has(proposal.operation))
        throw new GatewayRejectionV1('UNSUPPORTED_OPERATION');
      if (proposal.kind === 'navigate' && !proposal.goalId)
        throw new GatewayRejectionV1('INVALID_GOAL_REFERENCE');
      if (proposal.kind !== 'finish_exploration' && proposal.kind !== 'request_clarification' &&
        observations.length >= task.operatorConstraints.budgets.maxObservations)
        throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
      let validated: AgentProposalV1;
      try { validated = await dispatchValidatedProposal(proposal,
        gatewayState(task, observation, actions.length, observations.length,
          proposal.kind === 'finish_exploration' || proposal.kind === 'request_clarification'
            ? unresolved : new Set(ledger.authoredGoals.map(goal => goal.goalId)), usedScreenshots),
        async item => {
          try { await exploration!.dispatch(item, observation); return item; }
          catch (error) {
            if (item.kind === 'interact' || item.kind === 'navigate') actions.push(failedEvidence(item, observation));
            throw error;
          }
        });
        if (diagnostics && diagnostics.proposals.length < 100) diagnostics.proposals.push({ kind: proposal.kind,
          ...('goalId' in proposal && proposal.goalId ? { goalId: proposal.goalId } : {}),
          ...('observationId' in proposal ? { observationId: proposal.observationId } : {}),
          gatewayDecision: 'accepted' });
      } catch (error) {
        if (diagnostics && diagnostics.proposals.length < 100) diagnostics.proposals.push({ kind: proposal.kind,
          ...('goalId' in proposal && proposal.goalId ? { goalId: proposal.goalId } : {}),
          ...('observationId' in proposal ? { observationId: proposal.observationId } : {}),
          gatewayDecision: 'rejected', reason: error instanceof GatewayRejectionV1 ? error.code :
            'DISPATCH_FAILED' });
        throw error;
      }
      if (validated.kind === 'request_clarification') throw new Error('CLARIFICATION_REQUIRED');
      if (validated.kind === 'finish_exploration') {
        if (unresolved.size || ledger.unresolvedQuestions.length)
          throw new Error(intake!.acceptancePlan.goals.some(goal => goal.status === 'needs_refinement')
            ? 'ACCEPTANCE_UNRESOLVED' : 'EXPLORATION_UNVERIFIED');
        procedure = makeProcedure(makeTrace(unresolved));
        explored = true; break;
      }
      const before = observation;
      if (observations.length >= task.operatorConstraints.budgets.maxObservations)
        throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
      try {
        observation = validated.kind === 'observe' && validated.modality === 'screenshot'
          ? await exploration.captureScreenshot(before.observationId) : await exploration.observeCurrent();
        if (validated.kind === 'observe' && validated.modality === 'screenshot') usedScreenshots++;
        observations.push(observation);
      }
      catch (error) {
        if (validated.kind === 'interact' || validated.kind === 'navigate')
          actions.push(failedEvidence(validated, before, 'returned', 'POST_OBSERVATION_FAILED'));
        throw error;
      }
      if (validated.kind === 'verify') {
        const priorCoverage = verifyAcceptedRequirements(intake!, observations.slice(0, -1), actions)
          .coverage.find(item => item.goalId === validated.goalId)?.status ?? 'inconclusive';
        const afterCoverage = verifyAcceptedRequirements(intake!, observations, actions)
          .coverage.find(item => item.goalId === validated.goalId)?.status ?? 'inconclusive';
        const wasVerified = explorationVerified.has(validated.goalId);
        const observedResult = verifyProposal(validated, before, observation);
        const matchesAcceptance = verificationMatchesAcceptance(validated, intake!, before);
        const satisfied = matchesAcceptance && observedResult === 'true' &&
          afterCoverage === 'verified_true';
        const outcomeKey = verificationFingerprint(validated, before, observedResult, matchesAcceptance);
        const newInformation = !checkOutcomes.has(outcomeKey);
        checkOutcomes.add(outcomeKey);
        explorationChecks.push({ proposalId: validated.proposalId, goalId: validated.goalId,
          observationId: observation.observationId, satisfied, newInformation });
        if (satisfied) explorationVerified.add(validated.goalId);
        const requiredBefore = intake!.acceptancePlan.goals.filter(goal =>
          goal.kind === 'required_action' && goal.sourceSpan.start <
            (intake!.acceptancePlan.goals.find(item => item.goalId === validated.goalId)?.sourceSpan.start ?? 0));
        const missingActionEvidence = requiredBefore.some(goal =>
          verifyAcceptedRequirements(intake!, observations, actions).coverage.find(item =>
            item.goalId === goal.goalId)?.status !== 'verified_true');
        const missingOrderingEvidence = intake!.acceptancePlan.goals.some(goal =>
          goal.kind === 'constraint' && goal.constraint?.kind === 'required_order' &&
          verifyAcceptedRequirements(intake!, observations, actions).coverage.find(item =>
            item.goalId === goal.goalId)?.status !== 'verified_true');
        const advanced = satisfied && !wasVerified;
        const reason: VerificationFeedbackV1['reason'] = advanced ? 'advanced' :
          !matchesAcceptance ? 'predicate_mismatch' : observedResult === 'unknown' ? 'observation_unknown' :
            observedResult === 'false' ? 'observed_false' : missingOrderingEvidence ?
              'ordering_evidence_missing' : missingActionEvidence || afterCoverage === 'inconclusive' ?
                'action_evidence_missing' : wasVerified ? 'already_verified' : 'repeated_observation';
        const feedback: VerificationFeedbackV1 = { proposalId: validated.proposalId,
          goalId: validated.goalId, observationId: observation.observationId,
          predicateIdentity: verificationIdentity(validated, before).slice(0, 512),
          observedResult, matchesAcceptance,
          missingActionEvidence, missingOrderingEvidence, newEvidence: newInformation,
          progressBefore: { coverage: priorCoverage, explicitlyVerified: wasVerified },
          progressAfter: { coverage: afterCoverage,
            explicitlyVerified: explorationVerified.has(validated.goalId) }, reason };
        verificationFeedback.push(feedback);
        if (diagnostics && diagnostics.verifications.length < 100) diagnostics.verifications.push(feedback);
        ineffective = newInformation || advanced ? 0 : ineffective + 1;
        if (ineffective >= options.maxIneffectiveActions &&
            verificationFeedback.slice(0, feedbackSeenThrough).some(item =>
              item.goalId === validated.goalId && item.reason !== 'advanced'))
          throw new Error('REPEATED_INEFFECTIVE_VERIFICATION');
      }
      if (validated.kind === 'interact' || validated.kind === 'navigate') {
        const effect = observedTransition(before, observation);
        ineffective = effect ? 0 : ineffective + 1;
        const reusable = validated.kind === 'interact' ? persistentTarget(validated, before,
          ledger.authoredGoals.find(goal => goal.goalId === validated.goalId)?.requirement ?? '') : undefined;
        const operation = validated.kind === 'navigate' ? 'navigate' : validated.operation;
        const evidence = ActionEvidenceV1Schema.parse({ version: '1', evidenceId: newId('e'),
          proposalId: validated.proposalId, goalId: validated.goalId, operation,
          sourceObservationId: before.observationId,
          validatedTarget: validated.kind === 'navigate' ? validated.url : targetText(validated),
          targetWitness: targetWitness(validated),
          beforeUrl: before.url, beforeDocumentRevision: before.documentRevision,
          afterUrl: observation.url, afterDocumentRevision: observation.documentRevision,
          demonstratedTargets: reusable ? [reusable] : [], delivery: 'returned',
          afterObservationId: observation.observationId,
          ...(effect ? { observedEffect: effect } : {}) });
        actions.push(evidence);
        if (diagnostics && diagnostics.actions.length < 100) diagnostics.actions.push({
          goalId: evidence.goalId, operation: evidence.operation,
          effect: !effect ? 'none' : before.url !== observation.url ? 'url_changed' :
            effect === 'Accessibility snapshot changed' ? 'snapshot_changed' : 'control_changed' });
        if (ineffective >= options.maxIneffectiveActions) throw new Error('REPEATED_INEFFECTIVE_ACTION');
      }
      intake = promoteGroundedAcceptance(intake!, observations);
      if (validated.kind === 'interact' || validated.kind === 'navigate') {
        if (refinements < 2 && intake.acceptancePlan.goals.some(goal =>
          goal.status === 'needs_refinement')) {
          const candidate = await options.model.interpretRequirements({ original: { taskId: task.taskId,
            authoredInstruction: task.authoredInstruction, authoredDigest: task.authoredDigest,
            startUrl: task.startUrl }, observation: structuredClone(observation),
            previous: structuredClone(intake), remainingRefinements: 1 - refinements,
            ...(observation.screenshot ? { screenshotDataUrl: exploration.getScreenshotData(observation.screenshot.ref) } : {}) });
          deadline();
          intake = promoteGroundedAcceptance(validateRequirementIntake(task, observation,
            candidate, observations, intake), observations);
          ledger = intake.ledger;
          refinements++;
        }
      }
    }
    if (!explored && !unresolvedGoals(observation).size && !ledger.unresolvedQuestions.length) {
      procedure = makeProcedure(makeTrace(new Set()));
      explored = true;
    }
    if (!explored) throw new Error(intake?.acceptancePlan.goals.some(goal => goal.status === 'needs_refinement')
      ? 'ACCEPTANCE_UNRESOLVED' : 'MODEL_TURN_BUDGET_EXCEEDED');
    if (!procedure) throw new Error('PROCEDURE_NOT_DEMONSTRATED');
    await exploration.close(); exploration = undefined;
    enterPhase('cleanReset');
    clean = await options.openBrowser(); cleanSessionId = clean.sessionId;
    const proof = await options.reset.prepareCleanState(task);
    deadline();
    cleanStart = { ...proof };
    if (!proof.freshBrowserContext || !proof.applicationStateVerified || !proof.evidenceRef)
      throw new Error('RESET_UNVERIFIED');
    let current = await clean.observeInitial(task);
    const cleanObservationHistory: ObservationV1[] = [current];
    deadline();
    enterPhase('cleanExecution');
    let cleanObservations = 1;
    for (const step of procedure.steps) {
      deadline();
      const strategy = step.targetStrategies.find(item => item.status === 'demonstrated');
      if (step.operation !== 'navigate' && (!strategy ||
        !['role_name', 'visual_anchor'].includes(strategy.target.kind) ||
        !allowed.has(step.operation)))
        throw new Error('CLEAN_TARGET_UNSUPPORTED');
      let proposal: AgentProposalV1 = step.operation === 'navigate'
        ? { version: '1', proposalId: newId('p'), kind: 'navigate', observationId: current.observationId,
          goalId: step.goalIds[0]!, url: step.destinationUrl!, predictedEffect: step.expectedTransition }
        : { version: '1', proposalId: newId('p'), kind: 'interact',
          observationId: current.observationId, goalId: step.goalIds[0]!, operation: step.operation,
          target: strategy!.target, predictedEffect: step.expectedTransition } as AgentProposalV1;
      if (strategy?.target.kind === 'visual_anchor') {
        if (step.operation !== 'click' || cleanObservations >= task.operatorConstraints.budgets.maxObservations ||
            task.operatorConstraints.budgets.maxScreenshots < 1)
          throw new Error('CLEAN_TARGET_UNSUPPORTED');
        current = await clean.captureScreenshot(current.observationId);
        cleanObservationHistory.push(current);
        cleanObservations++;
        deadline();
        const screenshot = current.screenshot;
        if (!screenshot) throw new Error('CLEAN_VISUAL_EVIDENCE_MISSING');
        cleanVisualModelCalls++;
        proposal = AgentProposalV1Schema.parse(await options.model.propose({
          original: { taskId: task.taskId, authoredInstruction: task.authoredInstruction,
            authoredDigest: task.authoredDigest, startUrl: task.startUrl },
          ledger: structuredClone(ledger), acceptancePlan: structuredClone(intake!.acceptancePlan),
          observation: structuredClone(current), validatedHistory: [],
          unresolvedGoalIds: [step.goalIds[0]!], availableOperations: ['click'],
          remainingBudgets: { modelTurns: 1, browserActions: task.operatorConstraints.budgets.maxActions - cleanActions.length,
            elapsedMs: remainingTime() },
          maxContextCharacters: 24_000, screenshotDataUrl: clean.getScreenshotData(screenshot.ref),
          cleanVisualTarget: { description: strategy.target.description, context: strategy.target.context,
            expectedTransition: step.expectedTransition, goalId: step.goalIds[0]!, operation: 'click' } }));
        deadline();
        if (proposal.kind !== 'interact' || proposal.operation !== 'click' ||
            proposal.goalId !== step.goalIds[0] || proposal.observationId !== current.observationId)
          throw new Error('CLEAN_VISUAL_REIDENTIFICATION_FAILED');
        const freshTarget = proposal.target;
        if (freshTarget.kind !== 'visual_coordinate' && freshTarget.kind !== 'element_ref')
          throw new Error('CLEAN_VISUAL_REIDENTIFICATION_FAILED');
        if (freshTarget.kind === 'visual_coordinate' &&
            (freshTarget.description !== strategy.target.description ||
              freshTarget.context !== strategy.target.context ||
              freshTarget.screenshotRef !== screenshot.ref) ||
            !clean.matchesVisualAnchor(strategy.target, freshTarget, current))
          throw new Error('CLEAN_VISUAL_REIDENTIFICATION_FAILED');
        const identified = freshTarget.kind === 'element_ref'
          ? current.dom.elements.find(item => item.ref === freshTarget.ref)?.bounds : undefined;
        if (freshTarget.kind === 'element_ref' && !identified)
          throw new Error('CLEAN_VISUAL_REIDENTIFICATION_FAILED');
        cleanVisualReidentifications.push({ stepId: step.stepId, screenshotRef: screenshot.ref,
          proposalId: proposal.proposalId, targetKind: freshTarget.kind,
          x: freshTarget.kind === 'element_ref' ? identified!.x + identified!.width / 2 : freshTarget.x,
          y: freshTarget.kind === 'element_ref' ? identified!.y + identified!.height / 2 : freshTarget.y,
          description: strategy.target.description });
      }
      const before = current;
      if (cleanObservations >= task.operatorConstraints.budgets.maxObservations)
        throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
      await dispatchValidatedProposal(proposal,
        gatewayState(task, current, cleanActions.length, cleanObservations,
          new Set(ledger.authoredGoals.map(goal => goal.goalId)), current.screenshot ? 1 : 0),
        async item => {
          try { await clean!.dispatch(item, before); return item; }
          catch (error) {
            if (item.kind === 'interact' || item.kind === 'navigate') cleanActions.push(failedEvidence(item, before));
            throw error;
          }
        });
      if (cleanObservations >= task.operatorConstraints.budgets.maxObservations)
        throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
      try { current = await clean.observeCurrent(); }
      catch (error) {
        if (proposal.kind === 'interact' || proposal.kind === 'navigate')
          cleanActions.push(failedEvidence(proposal, before, 'returned', 'POST_OBSERVATION_FAILED'));
        throw error;
      }
      cleanObservations++;
      cleanObservationHistory.push(current);
      const effect = observedTransition(before, current);
      cleanActions.push(ActionEvidenceV1Schema.parse({ version: '1', evidenceId: newId('e'),
        proposalId: proposal.proposalId, goalId: step.goalIds[0], operation: step.operation,
        sourceObservationId: before.observationId,
        validatedTarget: step.operation === 'navigate' ? step.destinationUrl :
          targetText(proposal as Interaction),
        targetWitness: targetWitness(proposal as Extract<AgentProposalV1, { kind: 'interact' | 'navigate' }>),
        beforeUrl: before.url, beforeDocumentRevision: before.documentRevision,
        afterUrl: current.url, afterDocumentRevision: current.documentRevision,
        demonstratedTargets: strategy ? [strategy.target] : [], delivery: 'returned',
        afterObservationId: current.observationId,
        ...(effect ? { observedEffect: effect } : {}) }));
      if (!effect) throw new Error('CLEAN_ACTION_INEFFECTIVE');
      if (effect !== step.expectedTransition) throw new Error('CLEAN_TRANSITION_MISMATCH');
      deadline();
    }
    enterPhase('verificationCleanup');
    if (cleanObservations >= task.operatorConstraints.budgets.maxObservations)
      throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
    await clean.page.reload();
    current = await clean.observeCurrent();
    cleanObservationHistory.push(current);
    finalCleanState = { observationId: current.observationId, url: current.url,
      controls: current.dom.elements.slice(0, 30).map(item => ({
        ...(item.role ? { role: item.role } : {}), ...(item.name ? { name: item.name } : {}),
        ...(item.checked !== undefined ? { checked: item.checked } : {}) })) };
    deadline();
    const checked = verifyAcceptedRequirements(intake!, cleanObservationHistory, cleanActions);
    coverage = checked.coverage; trusted = checked.trusted;
    outcome = coverage.some(item => item.status === 'inconclusive') ? 'INCONCLUSIVE' :
      coverage.some(item => item.status === 'verified_false') ? 'VERIFIED_FAIL' : 'VERIFIED_PASS';
    await clean.close(); clean = undefined; cleanupVerified = true;
    deadline();
  } catch (error) {
    stopReason = error instanceof GatewayRejectionV1 ? error.code : error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    if (diagnostics && !diagnostics.firstTerminalFailure) diagnostics.firstTerminalFailure = stopReason;
    outcome = error instanceof GatewayRejectionV1 || error instanceof ZodError ||
      /BUDGET|UNVERIFIED|UNSUPPORTED|TARGET|REIDENTIFICATION|CLARIFICATION|INEFFECTIVE|TRANSITION|RESET|MODEL_TURN|NAVIGATION|ACCEPTANCE/.test(stopReason)
      ? 'BLOCKED' : 'ENVIRONMENT_FAILED';
  } finally {
    try { await exploration?.close(); await clean?.close(); cleanupVerified = true; }
    catch {
      cleanupVerified = false; outcome = 'ENVIRONMENT_FAILED'; stopReason = 'CLEANUP_FAILED';
      if (diagnostics && !diagnostics.firstTerminalFailure)
        diagnostics.firstTerminalFailure = stopReason;
    }
    const finished = now();
    timingsMs[phase] += Math.max(0, finished - phaseStarted);
    timingsMs.total = Math.max(0, finished - started);
  }
  const trace = ExplorationTraceV1Schema.parse({ version: '1', taskId: task.taskId,
    authoredDigest: task.authoredDigest, runId: traceId, observationIds: observations.map(item => item.observationId),
    proposals, actions, unresolvedGoalIds: explored ? [] : [...unresolvedGoals(observations.at(-1))] });
  if (diagnostics && intake) diagnostics.requirements = intake.acceptancePlan.goals.map(goal => ({
    goalId: goal.goalId, kind: goal.kind, status: goal.status,
    predicates: goal.predicates.map(predicate => ({ identity: safePredicateIdentity(predicate.kind, predicate),
      state: observations.length ? evaluateAcceptancePredicate(predicate, observations.at(-1)!) : 'unknown' })) }));
  return { trace, ...(procedure ? { procedure } : {}), observations, explorationActions: actions,
    timingsMs, ...(finalCleanState ? { finalCleanState } : {}),
    explorationChecks,
    ...(diagnostics ? { diagnostics } : {}),
    ...(stopReason ? { stopReason } : {}),
    cleanVisualModelCalls, cleanVisualReidentifications,
    result: result(task, ledger, procedure?.procedureId ?? 'unavailable', cleanSessionId,
      cleanStart, coverage, trusted, cleanActions.map(item => item.evidenceId), outcome, cleanupVerified) };
}
