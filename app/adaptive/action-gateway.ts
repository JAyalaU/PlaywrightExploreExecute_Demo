import { AgentProposalV1Schema, ObservationV1Schema, TaskEnvelopeV1Schema,
  type AgentProposalV1, type ObservationV1, type TargetHypothesisV1 } from './contracts.js';

type Interaction = Extract<AgentProposalV1, { kind: 'interact' }>;
export type RiskClassV1 = 'read' | 'reversible' | 'state_changing' | 'irreversible';
export interface TrustedGatewayStateV1 {
  readonly task: unknown;
  /** Supplied by the browser owner, not from the model or serialized trace. */
  readonly currentObservation: unknown;
  readonly binding: Readonly<{ observationId: string; sessionId: string; pageId: string;
    documentRevision: string; coordinateFrameId: string; screenshotRef?: string;
    scrollX?: number; scrollY?: number }>;
  readonly usedActions: number;
  readonly usedObservations: number;
  readonly usedScreenshots: number;
  /** Issued by the ledger owner; a model completion cannot omit open obligations. */
  readonly unresolvedGoalIds: ReadonlySet<string>;
  readonly visualCoordinateDispatchVerified: boolean;
  readonly authorizedRiskClasses: ReadonlySet<RiskClassV1>;
  readonly confirmedEffects: ReadonlySet<string>;
  /** Trusted policy classifies the actual target/operation, independently of model prose. */
  readonly classifyInteraction: (action: Interaction, observation: ObservationV1) =>
    Readonly<{ risk: RiskClassV1; effect: string }>;
}
export class GatewayRejectionV1 extends Error {
  constructor(readonly code: 'INVALID_PROPOSAL' | 'NO_CURRENT_OBSERVATION' | 'STALE_OBSERVATION' |
    'UNSUPPORTED_OPERATION' | 'TARGET_NOT_GROUNDED' | 'VISUAL_BINDING_INVALID' |
    'NAVIGATION_DENIED' | 'RISK_DENIED' | 'BUDGET_EXHAUSTED' |
    'INVALID_GOAL_REFERENCE') { super(code); }
}
export type DispatchableProposalV1 = Extract<AgentProposalV1,
  { kind: 'interact' | 'navigate' | 'observe' | 'verify' }>;

function sameViewport(a: ObservationV1['viewport'], b: ObservationV1['viewport']): boolean {
  return a.width === b.width && a.height === b.height && a.scale === b.scale;
}
function screenshotCurrent(observation: ObservationV1): boolean {
  const screenshot = observation.screenshot;
  return !!screenshot && screenshot.sessionId === observation.sessionId &&
    screenshot.pageId === observation.pageId &&
    screenshot.documentRevision === observation.documentRevision &&
    screenshot.coordinateFrameId === observation.coordinateFrameId &&
    sameViewport(screenshot.viewport, observation.viewport) &&
    Date.now() - Date.parse(screenshot.observedAt) <= 45_000 &&
    Date.parse(screenshot.observedAt) - Date.now() <= 2_000;
}
function visibleCenter(item: ObservationV1['dom']['elements'][number], observation: ObservationV1): boolean {
  const box = item.bounds;
  if (!box) return false;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  return x >= 0 && y >= 0 && x < observation.viewport.width && y < observation.viewport.height;
}
const visualActionRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch']);
function unnamedCandidate(item: ObservationV1['dom']['elements'][number], observation: ObservationV1): boolean {
  return !item.name && !!item.visual && item.enabled !== false &&
    visualActionRoles.has(item.role ?? '') && visibleCenter(item, observation);
}
function validateTarget(target: TargetHypothesisV1, observation: ObservationV1,
  visualEnabled: boolean, allowUnnamedClick = false,
  binding?: TrustedGatewayStateV1['binding']): void {
  const elements = observation.dom.elements;
  if (target.kind === 'element_ref') {
    const matches = elements.filter(item => item.ref === target.ref);
    if (matches.length !== 1) throw new GatewayRejectionV1('TARGET_NOT_GROUNDED');
    if (!matches[0]!.name && (!allowUnnamedClick || !visualEnabled ||
        !screenshotCurrent(observation) || !binding?.screenshotRef ||
        binding.screenshotRef !== observation.screenshot?.ref ||
        binding.scrollX !== observation.screenshot?.scrollX ||
        binding.scrollY !== observation.screenshot?.scrollY ||
        !unnamedCandidate(matches[0]!, observation) ||
        elements.filter(item => unnamedCandidate(item, observation)).length !== 1))
      throw new GatewayRejectionV1('TARGET_NOT_GROUNDED');
  }
  if (target.kind === 'role_name' && elements.filter(item =>
        item.role === target.role && item.name === target.name).length !== 1 ||
      target.kind === 'structural' && elements.filter(item => item.selector === target.selector).length !== 1)
    throw new GatewayRejectionV1('TARGET_NOT_GROUNDED');
  if (target.kind === 'visual_coordinate' && (!visualEnabled || !observation.screenshot ||
      target.screenshotRef !== observation.screenshot.ref ||
      !screenshotCurrent(observation) ||
      target.coordinateFrameId !== observation.coordinateFrameId ||
      !sameViewport(target.viewport, observation.viewport) ||
      target.x < 0 || target.y < 0 || target.x >= target.viewport.width ||
      target.y >= target.viewport.height)) throw new GatewayRejectionV1('VISUAL_BINDING_INVALID');
}
function currentObservation(state: TrustedGatewayStateV1, observationId: string): ObservationV1 {
  if (!state.currentObservation) throw new GatewayRejectionV1('NO_CURRENT_OBSERVATION');
  const parsed = ObservationV1Schema.safeParse(state.currentObservation);
  if (!parsed.success) throw new GatewayRejectionV1('NO_CURRENT_OBSERVATION');
  const observation = parsed.data;
  if (observationId !== observation.observationId || observationId !== state.binding.observationId ||
      observation.sessionId !== state.binding.sessionId || observation.pageId !== state.binding.pageId ||
      observation.documentRevision !== state.binding.documentRevision ||
      observation.coordinateFrameId !== state.binding.coordinateFrameId ||
      state.binding.screenshotRef !== undefined &&
        observation.screenshot?.ref !== state.binding.screenshotRef ||
      state.binding.scrollX !== undefined &&
        observation.screenshot?.scrollX !== state.binding.scrollX ||
      state.binding.scrollY !== undefined &&
        observation.screenshot?.scrollY !== state.binding.scrollY)
    throw new GatewayRejectionV1('STALE_OBSERVATION');
  return observation;
}

/** Validates model output before any browser adapter sees it. No browser call happens here. */
export function validateGatewayProposal(input: unknown, state: TrustedGatewayStateV1): AgentProposalV1 {
  const parsed = AgentProposalV1Schema.safeParse(input);
  if (!parsed.success) throw new GatewayRejectionV1('INVALID_PROPOSAL');
  const proposal = parsed.data;
  const task = TaskEnvelopeV1Schema.parse(state.task);
  if (proposal.kind === 'request_clarification') {
    if (!proposal.blockingGoalIds.length || proposal.blockingGoalIds.some(goalId =>
      !state.unresolvedGoalIds.has(goalId))) throw new GatewayRejectionV1('INVALID_GOAL_REFERENCE');
    return proposal;
  }
  if (proposal.kind === 'finish_exploration') {
    if (new Set(proposal.unresolvedGoalIds).size !== state.unresolvedGoalIds.size ||
        proposal.unresolvedGoalIds.some(goalId => !state.unresolvedGoalIds.has(goalId)))
      throw new GatewayRejectionV1('INVALID_GOAL_REFERENCE');
    return proposal;
  }
  if (proposal.goalId && !state.unresolvedGoalIds.has(proposal.goalId))
    throw new GatewayRejectionV1('INVALID_GOAL_REFERENCE');
  const observation = currentObservation(state, proposal.observationId);
  if (!task.operatorConstraints.allowedOrigins.some(origin =>
    new URL(origin).origin === new URL(observation.url).origin))
    throw new GatewayRejectionV1('NAVIGATION_DENIED');
  if (proposal.kind === 'observe') {
    if (state.usedObservations >= task.operatorConstraints.budgets.maxObservations ||
        proposal.modality === 'screenshot' &&
        state.usedScreenshots >= task.operatorConstraints.budgets.maxScreenshots)
      throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
    return proposal;
  }
  if (proposal.kind === 'verify') {
    if (proposal.predicate.kind === 'element_state')
      validateTarget(proposal.predicate.target, observation, state.visualCoordinateDispatchVerified);
    if (proposal.predicate.kind === 'visual' && proposal.predicate.screenshotRef !== observation.screenshot?.ref)
      throw new GatewayRejectionV1('VISUAL_BINDING_INVALID');
    return proposal;
  }
  if (state.usedActions >= task.operatorConstraints.budgets.maxActions)
    throw new GatewayRejectionV1('BUDGET_EXHAUSTED');
  if (proposal.kind === 'navigate') {
    const destination = new URL(proposal.url);
    if (destination.username || destination.password || !task.operatorConstraints.allowedOrigins.some(origin =>
      new URL(origin).origin === destination.origin)) throw new GatewayRejectionV1('NAVIGATION_DENIED');
    return proposal;
  }
  if (!task.operatorConstraints.allowedOperations.includes(proposal.operation))
    throw new GatewayRejectionV1('UNSUPPORTED_OPERATION');
  if (proposal.target.kind === 'visual_coordinate' && proposal.operation !== 'click')
    throw new GatewayRejectionV1('UNSUPPORTED_OPERATION');
  validateTarget(proposal.target, observation, state.visualCoordinateDispatchVerified,
    proposal.operation === 'click', state.binding);
  const classified = state.classifyInteraction(proposal, observation);
  if (task.operatorConstraints.prohibitedEffects.includes(classified.effect) ||
      task.operatorConstraints.confirmationRequiredEffects.includes(classified.effect) &&
        !state.confirmedEffects.has(classified.effect) ||
      !state.authorizedRiskClasses.has(classified.risk)) throw new GatewayRejectionV1('RISK_DENIED');
  return proposal;
}

/** Phase 0 dispatch seam; browser adapters own action execution and after-observation. */
export async function dispatchValidatedProposal<T>(input: unknown, state: TrustedGatewayStateV1,
  dispatch: (proposal: DispatchableProposalV1) => Promise<T>): Promise<T | AgentProposalV1> {
  const proposal = validateGatewayProposal(input, state);
  if (proposal.kind === 'request_clarification' || proposal.kind === 'finish_exploration') return proposal;
  return dispatch(proposal);
}
