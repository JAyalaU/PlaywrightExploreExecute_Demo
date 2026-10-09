import { randomUUID } from 'node:crypto';
import { RequirementAcceptancePlanV1Schema, validateRequirementLedger,
  type AcceptancePredicateV1, type ActionEvidenceV1, type ObservationV1,
  type RequirementAcceptancePlanV1, type RequirementLedgerV1,
  type TaskEnvelopeV1 } from './contracts.js';
import { observedViewportRegion } from './browser.js';

export interface RequirementIntakeV1 { ledger: RequirementLedgerV1;
  acceptancePlan: RequirementAcceptancePlanV1 }

/** Intake may interpret clauses, but every substantive authored word must remain represented. */
function coversAuthoredInstruction(task: TaskEnvelopeV1, ledger: RequirementLedgerV1): boolean {
  const covered = new Array(task.authoredInstruction.length).fill(false);
  for (const goal of ledger.authoredGoals)
    for (let index = goal.sourceSpan.start; index < goal.sourceSpan.end; index++) covered[index] = true;
  for (const match of task.authoredInstruction.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0].toLocaleLowerCase();
    if (['and', 'then', 'please'].includes(word)) continue;
    if (![...word].some((_, offset) => covered[match.index + offset])) return false;
  }
  const instruction = task.authoredInstruction;
  const separators = /,\s*|\s+and\s+|\s+then\s+|[.;]+/gi;
  const clauses: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const separator of instruction.matchAll(separators)) {
    clauses.push({ start, end: separator.index });
    start = separator.index + separator[0].length;
  }
  clauses.push({ start, end: instruction.length });
  const assigned = new Set<string>();
  for (const clause of clauses) {
    const words = [...instruction.slice(clause.start, clause.end).matchAll(/[\p{L}\p{N}]+/gu)]
      .filter(match => !['and', 'then', 'please'].includes(match[0].toLocaleLowerCase()));
    if (!words.length) continue;
    const matches = ledger.authoredGoals.filter(goal => words.every(word =>
      goal.sourceSpan.start <= clause.start + word.index &&
      goal.sourceSpan.end >= clause.start + word.index + word[0].length));
    if (matches.length !== 1 || assigned.has(matches[0]!.goalId)) return false;
    assigned.add(matches[0]!.goalId);
  }
  return assigned.size === ledger.authoredGoals.length;
}

function predicateGrounded(predicate: AcceptancePredicateV1, observations: readonly ObservationV1[]): boolean {
  // URL and path are browser-observable on every page. The expected value need not
  // have been reached yet; that is predicate truth, not predicate grounding.
  if (predicate.kind === 'url') return observations.some(observation => !!observation.url);
  if (predicate.property === 'count' || predicate.property === 'exists' ||
      predicate.property === 'visible')
    return observations.some(observation => evaluateAcceptancePredicate(predicate, observation) !== 'unknown');
  return observations.some(observation =>
    evaluateAcceptancePredicate(predicate, observation) !== 'unknown');
}

function constraintGrounded(goal: RequirementAcceptancePlanV1['goals'][number],
  observations: readonly ObservationV1[]): boolean {
  const constraint = goal.constraint;
  if (!constraint) return false;
  if (constraint.kind === 'required_order' || !constraint.target) return true;
  return observations.some(observation => observation.dom.elements.some(item =>
    item.role === constraint.target!.role && item.name === constraint.target!.name));
}

function validatePredicate(predicate: AcceptancePredicateV1, task: TaskEnvelopeV1): void {
  if (predicate.kind !== 'url') return;
  if (predicate.comparison === 'path_equals') {
    if (!predicate.value.startsWith('/') || predicate.value.startsWith('//') ||
        predicate.value.includes('?') || predicate.value.includes('#') ||
        predicate.value.includes('\\')) throw new Error('ACCEPTANCE_PREDICATE_INVALID');
  } else {
    let parsed: URL;
    try { parsed = new URL(predicate.value); } catch { throw new Error('ACCEPTANCE_PREDICATE_INVALID'); }
    if (!task.operatorConstraints.allowedOrigins.some(origin => new URL(origin).origin === parsed.origin))
      throw new Error('ACCEPTANCE_PREDICATE_INVALID');
  }
}

export function validateRequirementIntake(task: TaskEnvelopeV1, current: ObservationV1,
  raw: unknown, trustedObservations: readonly ObservationV1[], previous?: RequirementIntakeV1): RequirementIntakeV1 {
  if (!raw || typeof raw !== 'object') throw new Error('REQUIREMENT_INTAKE_INVALID');
  const input = raw as Record<string, unknown>;
  const ledger = validateRequirementLedger(task, input.ledger);
  const plan = RequirementAcceptancePlanV1Schema.parse(input.acceptancePlan);
  if (!coversAuthoredInstruction(task, ledger) || plan.taskId !== task.taskId ||
      plan.authoredDigest !== task.authoredDigest || plan.sourceObservationId !== current.observationId ||
      plan.goals.length !== ledger.authoredGoals.length ||
      new Set(plan.goals.map(goal => goal.goalId)).size !== plan.goals.length)
    throw new Error('REQUIREMENT_INTAKE_INVALID');
  if (ledger.authoredGoals.some(goal => goal.fulfillment !== 'pending' || goal.evidenceRefs.length ||
      !['literal', 'hypothesis'].includes(goal.interpretationStatus)))
    throw new Error('MODEL_GOAL_SELF_REPORT');
  for (const goal of ledger.authoredGoals) {
    const accepted = plan.goals.find(item => item.goalId === goal.goalId);
    const explicitProhibition = /\b(?:never|avoid|must\s+not|do\s+not|don't|without)\b/i.test(goal.requirement);
    const forbiddenOperationWord = explicitProhibition && goal.requirement.match(
      /\b(click|check|uncheck|fill|select|press|scroll|navigate)\b/i)?.[1]?.toLowerCase();
    const precedingAction = ledger.authoredGoals.filter(item => item.kind === 'required_action' &&
      item.sourceSpan.start < goal.sourceSpan.start).sort((a, b) =>
      b.sourceSpan.start - a.sourceSpan.start)[0];
    if (!accepted || accepted.kind !== goal.kind || accepted.requirement !== goal.requirement ||
        accepted.sourceSpan.start !== goal.sourceSpan.start || accepted.sourceSpan.end !== goal.sourceSpan.end ||
        (goal.kind !== 'constraint' && accepted.predicates.length === 0 &&
          accepted.status !== 'needs_refinement') ||
        (goal.kind === 'constraint' && (accepted.predicates.length > 0 ||
          (!accepted.constraint && accepted.status !== 'needs_refinement'))) ||
        (goal.kind !== 'constraint' && !!accepted.constraint) ||
        (goal.kind === 'required_action' && !accepted.action) ||
        (goal.kind !== 'required_action' && !!accepted.action) ||
        (explicitProhibition && goal.kind !== 'constraint') ||
        (explicitProhibition && forbiddenOperationWord &&
          accepted.constraint?.kind !== 'forbid_action' &&
          (accepted.status !== 'needs_refinement' || !!accepted.constraint)) ||
        (explicitProhibition && accepted.constraint?.kind === 'forbid_action' &&
          (forbiddenOperationWord && accepted.constraint.operation !== forbiddenOperationWord ||
            accepted.constraint.target && !goal.requirement.toLocaleLowerCase()
              .includes(accepted.constraint.target.name.toLocaleLowerCase()))) ||
        (goal.kind === 'required_action' && /^then\b/i.test(goal.requirement.trim()) &&
          (!precedingAction || !accepted.action?.afterGoalIds.includes(precedingAction.goalId))) ||
        (goal.kind === 'constraint' && /\bin\s+order\b/i.test(goal.requirement) &&
          accepted.constraint?.kind !== 'required_order' && accepted.status !== 'needs_refinement') ||
        accepted.action?.afterGoalIds.some(id => id === goal.goalId ||
          !ledger.authoredGoals.some(item => item.goalId === id && item.kind === 'required_action')))
      throw new Error('REQUIREMENT_INTAKE_INVALID');
    if (accepted.constraint?.kind === 'required_order') {
      const { beforeGoalId, afterGoalId } = accepted.constraint;
      const before = ledger.authoredGoals.find(item => item.goalId === beforeGoalId);
      const after = ledger.authoredGoals.find(item => item.goalId === afterGoalId);
      if (!before || !after || before.goalId === after.goalId ||
          before.kind !== 'required_action' || after.kind !== 'required_action' ||
          /\bin\s+order\b/i.test(goal.requirement) &&
            before.sourceSpan.start >= after.sourceSpan.start)
        throw new Error('REQUIREMENT_INTAKE_INVALID');
    }
    for (const predicate of accepted.predicates) validatePredicate(predicate, task);
    if (accepted.status === 'grounded' && (accepted.kind === 'constraint'
      ? !constraintGrounded(accepted, trustedObservations)
      : !accepted.predicates.every(predicate => predicateGrounded(predicate, trustedObservations))))
      throw new Error('ACCEPTANCE_NOT_GROUNDED');
  }
  // Dependency edges refer only to authored required actions. A cycle has no
  // possible first action, regardless of what browser evidence later appears.
  const byGoalId = new Map(plan.goals.map(goal => [goal.goalId, goal]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (goalId: string): void => {
    if (visiting.has(goalId)) throw new Error('REQUIREMENT_INTAKE_INVALID');
    if (visited.has(goalId)) return;
    visiting.add(goalId);
    for (const dependency of byGoalId.get(goalId)?.action?.afterGoalIds ?? []) visit(dependency);
    visiting.delete(goalId);
    visited.add(goalId);
  };
  for (const goal of plan.goals) if (goal.action) visit(goal.goalId);
  if (previous) {
    if (JSON.stringify(previous.ledger.authoredGoals.map(({ goalId, kind, sourceSpan, requirement }) =>
      ({ goalId, kind, sourceSpan, requirement }))) !==
      JSON.stringify(ledger.authoredGoals.map(({ goalId, kind, sourceSpan, requirement }) =>
        ({ goalId, kind, sourceSpan, requirement })))) throw new Error('AUTHORED_GOALS_CHANGED');
    for (const prior of previous.acceptancePlan.goals) {
      const next = plan.goals.find(goal => goal.goalId === prior.goalId);
      if (prior.status === 'grounded' && JSON.stringify({ predicates: prior.predicates, action: prior.action,
        constraint: prior.constraint }) !==
          JSON.stringify({ predicates: next?.predicates, action: next?.action, constraint: next?.constraint }))
        throw new Error('GROUNDED_ACCEPTANCE_CHANGED');
    }
  }
  return { ledger, acceptancePlan: plan };
}

export function promoteGroundedAcceptance(intake: RequirementIntakeV1,
  trustedObservations: readonly ObservationV1[]): RequirementIntakeV1 {
  return { ledger: intake.ledger, acceptancePlan: { ...intake.acceptancePlan,
    goals: intake.acceptancePlan.goals.map(goal => ({ ...goal,
      status: (goal.kind === 'constraint' ? constraintGrounded(goal, trustedObservations) :
        goal.predicates.length > 0 && goal.predicates.every(predicate =>
          predicateGrounded(predicate, trustedObservations)))
        ? 'grounded' as const : goal.status })) } };
}

type PredicateValue = 'true' | 'false' | 'unknown';
export function evaluateAcceptancePredicate(predicate: AcceptancePredicateV1,
  observation: ObservationV1): PredicateValue {
  if (predicate.kind === 'url') return (predicate.comparison === 'equals'
    ? observation.url === predicate.value : new URL(observation.url).pathname === predicate.value) ? 'true' : 'false';
  const matches = observation.dom.elements.filter(element =>
    element.role === predicate.role && element.name === predicate.name);
  if (predicate.property === 'exists') {
    if (matches.length === 0 && !observation.dom.complete) return 'unknown';
    return (matches.length > 0) === predicate.equals ? 'true' : 'false';
  }
  if (predicate.property === 'count') return observation.dom.complete
    ? matches.length === predicate.equals ? 'true' : 'false' : 'unknown';
  if (predicate.property === 'visible' && matches.length === 0 && observation.dom.complete)
    return predicate.equals === false ? 'true' : 'false';
  if (matches.length !== 1) return 'unknown';
  const element = matches[0]!;
  if (predicate.property === 'visible') {
    if (!element.bounds) return 'unknown';
    const b = element.bounds;
    const visible = b.x < observation.viewport.width && b.y < observation.viewport.height &&
      b.x + b.width > 0 && b.y + b.height > 0;
    return visible === predicate.equals ? 'true' : 'false';
  }
  const actual = predicate.property === 'enabled' ? element.enabled :
    predicate.property === 'checked' ? element.checked : element.value;
  return actual === undefined ? 'unknown' : actual === predicate.equals ? 'true' : 'false';
}

function allPredicates(goal: RequirementAcceptancePlanV1['goals'][number], observation: ObservationV1): PredicateValue {
  if (!goal.predicates.length) return 'unknown';
  const values = goal.predicates.map(predicate => evaluateAcceptancePredicate(predicate, observation));
  return values.includes('false') ? 'false' : values.includes('unknown') ? 'unknown' : 'true';
}

function targetWitnessValid(action: ActionEvidenceV1, before: ObservationV1,
  goal: RequirementAcceptancePlanV1['goals'][number]): boolean {
  const witness = action.targetWitness;
  if (!witness || witness.observationId !== before.observationId) return false;
  const target = witness.target;
  if (action.operation === 'navigate') return target.kind === 'navigation' &&
    target.url === action.validatedTarget && action.afterUrl === target.url;
  if (target.kind === 'navigation' || !action.demonstratedTargets.length ||
      action.validatedTarget !== JSON.stringify(target).slice(0, 1024)) return false;
  const matches = target.kind === 'element_ref' ? before.dom.elements.filter(item => item.ref === target.ref) :
    target.kind === 'role_name' ? before.dom.elements.filter(item =>
      item.role === target.role && item.name === target.name) : [];
  if (target.kind === 'element_ref' || target.kind === 'role_name') {
    if (matches.length !== 1) return false;
    const item = matches[0]!;
    if (!item.name && (!before.screenshot || !item.bounds || !item.visual ||
        !action.demonstratedTargets.some(anchor => anchor.kind === 'visual_anchor' &&
          visualAnchorMatches(anchor, item, before)))) return false;
    if (['check', 'uncheck', 'fill', 'select'].includes(action.operation) &&
        !goal.predicates.some(predicate => predicate.kind === 'element' &&
          predicate.role === item.role && predicate.name === item.name)) return false;
    return true;
  }
  if (target.kind !== 'visual_coordinate') return false;
  const candidates = before.dom.elements.filter(item => item.bounds && item.visual && item.enabled !== false &&
    target.x >= item.bounds.x && target.y >= item.bounds.y &&
    target.x < item.bounds.x + item.bounds.width && target.y < item.bounds.y + item.bounds.height);
  return candidates.length === 1 && action.demonstratedTargets.some(anchor =>
    anchor.kind === 'visual_anchor' && visualAnchorMatches(anchor, candidates[0]!, before)) &&
    !!before.screenshot && target.screenshotRef === before.screenshot.ref &&
    target.coordinateFrameId === before.coordinateFrameId &&
    target.viewport.width === before.viewport.width && target.viewport.height === before.viewport.height &&
    target.viewport.scale === before.viewport.scale && target.x >= 0 && target.y >= 0 &&
    target.x < before.viewport.width && target.y < before.viewport.height;
}

function visualAnchorMatches(anchor: Extract<ActionEvidenceV1['demonstratedTargets'][number],
  { kind: 'visual_anchor' }>, item: ObservationV1['dom']['elements'][number],
  observation: ObservationV1): boolean {
  if (!item.visual || !item.bounds) return false;
  return (!anchor.observedRole || anchor.observedRole === item.role) &&
    (!anchor.visualKind || anchor.visualKind === item.visual.kind) &&
    (!anchor.visualSignature || anchor.visualSignature === item.visual.signature) &&
    (!anchor.viewportRegion || anchor.viewportRegion === observedViewportRegion(item.bounds,
      observation.viewport));
}

function witnessSemanticTarget(action: ActionEvidenceV1, before: ObservationV1):
  { role: string; name: string } | undefined {
  const target = action.targetWitness?.target;
  if (!target) return undefined;
  if (target.kind === 'role_name') return before.dom.elements.filter(item =>
    item.role === target.role && item.name === target.name).length === 1 ? target : undefined;
  const matches = target.kind === 'element_ref' ? before.dom.elements.filter(item => item.ref === target.ref) :
    target.kind === 'visual_coordinate' ? before.dom.elements.filter(item => item.bounds &&
      target.x >= item.bounds.x && target.y >= item.bounds.y &&
      target.x < item.bounds.x + item.bounds.width && target.y < item.bounds.y + item.bounds.height) : [];
  return matches.length === 1 && matches[0]?.role && matches[0]?.name
    ? { role: matches[0].role, name: matches[0].name } : undefined;
}

/** Independent clean verifier. Delivery, observation lineage and state change establish action causality. */
export function verifyAcceptedRequirements(intake: RequirementIntakeV1,
  cleanObservations: readonly ObservationV1[], actions: readonly ActionEvidenceV1[]) {
  const trusted = new Set<string>();
  const singleSession = cleanObservations.every(observation =>
    observation.sessionId === cleanObservations[0]?.sessionId);
  const final = singleSession ? cleanObservations.at(-1) : undefined;
  const byId = new Map(cleanObservations.map(observation => [observation.observationId, observation]));
  const observationIndex = new Map(cleanObservations.map((observation, index) => [observation.observationId, index]));
  const goalById = new Map(intake.acceptancePlan.goals.map(goal => [goal.goalId, goal]));
  const proofCache = new Map<string, boolean>();
  const actionProves = (goal: RequirementAcceptancePlanV1['goals'][number],
    action: ActionEvidenceV1, index: number): boolean => {
    if (!singleSession) return false;
    const key = `${goal.goalId}:${index}`;
    if (proofCache.has(key)) return proofCache.get(key)!;
    if (action.goalId !== goal.goalId || action.operation !== goal.action?.operation ||
        action.delivery !== 'returned' || !action.observedEffect || !action.afterObservationId) return false;
    const before = byId.get(action.sourceObservationId), after = byId.get(action.afterObservationId);
    const beforeIndex = observationIndex.get(action.sourceObservationId);
    const afterIndex = observationIndex.get(action.afterObservationId);
    if (!before || !after || before.sessionId !== after.sessionId ||
        beforeIndex === undefined || afterIndex === undefined || afterIndex <= beforeIndex ||
        action.beforeUrl !== before.url || action.afterUrl !== after.url ||
        action.beforeDocumentRevision !== before.documentRevision ||
        action.afterDocumentRevision !== after.documentRevision ||
        !targetWitnessValid(action, before, goal) ||
        allPredicates(goal, before) !== 'false' || allPredicates(goal, after) !== 'true') return false;
    const proved = goal.action!.afterGoalIds.every(dependency => {
      const priorGoal = goalById.get(dependency);
      return priorGoal?.kind === 'required_action' && priorGoal.status === 'grounded' &&
        actions.slice(0, index).some((prior, priorIndex) =>
          prior.goalId === dependency && prior.afterObservationId !== undefined &&
          (observationIndex.get(prior.afterObservationId) ?? Number.POSITIVE_INFINITY) <= beforeIndex &&
          actionProves(priorGoal, prior, priorIndex));
    });
    proofCache.set(key, proved);
    return proved;
  };
  const coverage = intake.acceptancePlan.goals.map(goal => {
    let value: PredicateValue = goal.kind === 'required_action' || goal.kind === 'constraint' ? 'unknown' :
      final ? allPredicates(goal, final) : 'unknown';
    if (goal.status !== 'grounded') value = 'unknown';
    if (goal.status === 'grounded' && goal.kind === 'required_action') {
      value = actions.some((action, index) => actionProves(goal, action, index)) ? 'true' : 'unknown';
    }
    if (goal.status === 'grounded' && goal.kind === 'constraint') {
      const constraint = goal.constraint;
      if (constraint?.kind === 'forbid_action') {
        value = 'true';
        for (const action of actions.filter(item => item.operation === constraint.operation)) {
          if (!constraint.target) { value = 'false'; break; }
          const before = byId.get(action.sourceObservationId);
          if (!before || !action.targetWitness || action.targetWitness.observationId !== before.observationId) {
            value = 'unknown'; continue;
          }
          const semantic = witnessSemanticTarget(action, before);
          if (!semantic) { value = 'unknown'; continue; }
          if (semantic.role === constraint.target.role && semantic.name === constraint.target.name) {
            value = 'false'; break;
          }
        }
      } else if (constraint?.kind === 'required_order') {
        const beforeGoal = intake.acceptancePlan.goals.find(item => item.goalId === constraint.beforeGoalId);
        const afterGoal = intake.acceptancePlan.goals.find(item => item.goalId === constraint.afterGoalId);
        const first = beforeGoal ? actions.flatMap((action, index) =>
          actionProves(beforeGoal, action, index) ? [index] : []) : [];
        const second = afterGoal ? actions.flatMap((action, index) =>
          actionProves(afterGoal, action, index) ? [index] : []) : [];
        value = !first.length || !second.length ? 'unknown' :
          first.some(a => second.some(b => a < b &&
            (observationIndex.get(actions[a]!.afterObservationId!) ?? Number.POSITIVE_INFINITY) <=
            (observationIndex.get(actions[b]!.sourceObservationId) ?? -1))) ? 'true' : 'false';
      }
    }
    if (!singleSession) value = 'unknown';
    const status = value === 'true' ? 'verified_true' as const :
      value === 'false' ? 'verified_false' as const : 'inconclusive' as const;
    if (status === 'inconclusive') return { goalId: goal.goalId, status };
    const evidenceRef = `v${randomUUID().replaceAll('-', '')}`; trusted.add(evidenceRef);
    return { goalId: goal.goalId, status, evidenceRef };
  });
  return { coverage, trusted };
}
