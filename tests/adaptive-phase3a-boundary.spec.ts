import { expect, test } from '@playwright/test';
import { authoredDigest, type ActionEvidenceV1, type ObservationV1,
  type RequirementAcceptancePlanV1,
  type RequirementLedgerV1, type TaskEnvelopeV1 } from '../app/adaptive/contracts.js';
import { evaluateAcceptancePredicate, promoteGroundedAcceptance, validateRequirementIntake,
  verifyAcceptedRequirements } from '../app/adaptive/requirement-acceptance.js';

const instruction = 'Open my account settings, enable email notifications, and verify that email notifications are enabled.';
const task: TaskEnvelopeV1 = { version: '1', taskId: 'phase3a', authoredInstruction: instruction,
  authoredDigest: authoredDigest(instruction), startUrl: 'http://localhost:9000/', approvalRef: 'approved',
  operatorConstraints: { allowedOrigins: ['http://localhost:9000'], prohibitedEffects: [],
    confirmationRequiredEffects: [], allowedOperations: ['click', 'check'],
    budgets: { maxActions: 8, maxObservations: 12, maxScreenshots: 1 } } };
const phrases = ['Open my account settings', 'enable email notifications',
  'verify that email notifications are enabled'];
const ledger: RequirementLedgerV1 = { version: '1', taskId: task.taskId,
  authoredDigest: task.authoredDigest, authoredGoals: phrases.map((requirement, index) => ({
    goalId: `g${index}`, kind: (['required_action', 'outcome', 'assertion'] as const)[index]!,
    sourceSpan: { start: instruction.indexOf(requirement),
      end: instruction.indexOf(requirement) + requirement.length }, requirement,
    interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] })),
  inferredPrerequisites: [], unresolvedQuestions: [] };
const observation = (observationId: string, path: string, checked?: boolean): ObservationV1 => ({
  version: '1', observationId, sessionId: 'clean', pageId: 'page',
  documentRevision: `rev${observationId}`, coordinateFrameId: `frame${observationId}`,
  url: `http://localhost:9000${path}`, observedAt: '2026-10-07T00:00:00.000Z',
  viewport: { width: 800, height: 600, scale: 1 },
  accessibility: { snapshotRef: `a${observationId}`, summary: '' },
  dom: { factsRef: `d${observationId}`, summary: '', complete: true,
    elements: checked === undefined ? [
      { ref: `e${observationId}`, role: 'button', name: 'Settings', enabled: true,
        bounds: { x: 10, y: 20, width: 120, height: 24 } }] : [
      { ref: `e${observationId}`, role: 'checkbox', name: 'Email notifications', checked,
        enabled: true, bounds: { x: 10, y: 20, width: 120, height: 24 } }] } });
const plan = (sourceObservationId: string) => ({ version: '1' as const, taskId: task.taskId,
  authoredDigest: task.authoredDigest, sourceObservationId,
  goals: ledger.authoredGoals.map(goal => ({ goalId: goal.goalId, kind: goal.kind,
    sourceSpan: goal.sourceSpan, requirement: goal.requirement, status: 'hypothesis' as const,
    predicates: goal.goalId === 'g0'
      ? [{ kind: 'url' as const, comparison: 'path_equals' as const, value: '/settings' }]
      : [{ kind: 'element' as const, role: 'checkbox', name: 'Email notifications',
        property: 'checked' as const, equals: true }],
    ...(goal.goalId === 'g0' ? { action: { operation: 'click' as const, afterGoalIds: [] } } : {}) })) });
const acceptedGoal = (goal: RequirementLedgerV1['authoredGoals'][number]) => ({
  goalId: goal.goalId, kind: goal.kind, sourceSpan: goal.sourceSpan, requirement: goal.requirement });
const action = (goalId: string, operation: 'click' | 'check', before: ObservationV1,
  after: ObservationV1): ActionEvidenceV1 => ({ version: '1', evidenceId: `action${goalId}`,
  proposalId: `proposal${goalId}`, goalId, operation, sourceObservationId: before.observationId,
  validatedTarget: JSON.stringify({ kind: 'role_name', role: operation === 'click' ? 'button' : 'checkbox',
    name: operation === 'click' ? 'Settings' : 'Email notifications' }),
  targetWitness: { observationId: before.observationId,
    target: { kind: 'role_name', role: operation === 'click' ? 'button' : 'checkbox',
      name: operation === 'click' ? 'Settings' : 'Email notifications' } }, beforeUrl: before.url,
  beforeDocumentRevision: before.documentRevision, afterUrl: after.url,
  afterDocumentRevision: after.documentRevision,
  demonstratedTargets: [{ kind: 'role_name', role: operation === 'click' ? 'button' : 'checkbox',
    name: operation === 'click' ? 'Settings' : 'Email notifications' }], delivery: 'returned',
  afterObservationId: after.observationId, observedEffect: `changed ${goalId}` });

function genericChain() {
  const authoredInstruction = 'Open Panel, navigate to Preferences, enable Reminders, and verify Reminders are enabled.';
  const chainTask = { ...task, authoredInstruction, authoredDigest: authoredDigest(authoredInstruction) };
  const phrases = ['Open Panel', 'navigate to Preferences', 'enable Reminders',
    'verify Reminders are enabled'];
  const goals: RequirementLedgerV1['authoredGoals'] = phrases.map((requirement, index) => ({
    goalId: `chain${index}`, kind: index === 3 ? 'assertion' : 'required_action',
    sourceSpan: { start: authoredInstruction.indexOf(requirement),
      end: authoredInstruction.indexOf(requirement) + requirement.length }, requirement,
    interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] }));
  const chainLedger: RequirementLedgerV1 = { version: '1', taskId: chainTask.taskId,
    authoredDigest: chainTask.authoredDigest, authoredGoals: goals,
    inferredPrerequisites: [{ id: 'panel_hint', description: 'Panel reveals the route',
      supportsGoalIds: ['chain1'] }], unresolvedQuestions: [] };
  const element = (ref: string, role: string, name: string, checked?: boolean) => ({ ref, role, name,
    enabled: true, ...(checked === undefined ? {} : { checked }),
    bounds: { x: 10, y: 20, width: 120, height: 24 } });
  const home = observation('chainhome', '/');
  home.dom.elements = [element('panel0', 'button', 'Panel')];
  const menu = observation('chainmenu', '/');
  menu.dom.elements = [element('panel1', 'button', 'Panel'),
    element('prefs1', 'link', 'Preferences')];
  const preferences = observation('chainprefs', '/preferences');
  preferences.dom.elements = [element('reminders0', 'checkbox', 'Reminders', false)];
  const checked = observation('chainchecked', '/preferences');
  checked.dom.elements = [element('reminders1', 'checkbox', 'Reminders', true)];
  const observations = [home, menu, preferences, checked];
  const predicates: RequirementAcceptancePlanV1['goals'][number]['predicates'][] = [
    [{ kind: 'element', role: 'link', name: 'Preferences', property: 'exists', equals: true }],
    [{ kind: 'url', comparison: 'path_equals', value: '/preferences' }],
    [{ kind: 'element', role: 'checkbox', name: 'Reminders', property: 'checked', equals: true }],
    [{ kind: 'element', role: 'checkbox', name: 'Reminders', property: 'checked', equals: true }],
  ];
  const plan: RequirementAcceptancePlanV1 = { version: '1', taskId: chainTask.taskId,
    authoredDigest: chainTask.authoredDigest, sourceObservationId: home.observationId,
    goals: goals.map((goal, index) => ({ ...acceptedGoal(goal), status: 'hypothesis',
      predicates: predicates[index]!, ...(index < 3 ? { action: { operation: index === 2 ?
        'check' as const : 'click' as const, afterGoalIds: index ? [`chain${index - 1}`] : [] } } : {}) })) };
  const intake = promoteGroundedAcceptance(validateRequirementIntake(chainTask, home,
    { ledger: chainLedger, acceptancePlan: plan }, [home]), observations);
  const receipt = (goalId: string, operation: 'click' | 'check', before: ObservationV1,
    after: ObservationV1, role: string, name: string): ActionEvidenceV1 => {
    const target = { kind: 'role_name' as const, role, name };
    return { version: '1', evidenceId: `e${goalId}`, proposalId: `p${goalId}`, goalId,
      operation, sourceObservationId: before.observationId,
      validatedTarget: JSON.stringify(target), targetWitness: { observationId: before.observationId,
        target }, beforeUrl: before.url, afterUrl: after.url,
      beforeDocumentRevision: before.documentRevision, afterDocumentRevision: after.documentRevision,
      demonstratedTargets: [target], delivery: 'returned', afterObservationId: after.observationId,
      observedEffect: `changed ${goalId}` };
  };
  const actions = [receipt('chain0', 'click', home, menu, 'button', 'Panel'),
    receipt('chain1', 'click', menu, preferences, 'link', 'Preferences'),
    receipt('chain2', 'check', preferences, checked, 'checkbox', 'Reminders')];
  return { intake, observations, actions, receipt };
}

const verified = 'verified_true', inconclusive = 'inconclusive';
const chainCases: Array<{ name: string; change: (fixture: ReturnType<typeof genericChain>) => void;
  expected: string[] }> = [
  { name: 'valid three-step menu navigation checkbox chain', change: () => {},
    expected: [verified, verified, verified, verified] },
  { name: 'omitted menu-opening action', change: fixture => { fixture.actions.splice(0, 1); },
    expected: [inconclusive, inconclusive, inconclusive, verified] },
  { name: 'omitted navigation action', change: fixture => { fixture.actions.splice(1, 1); },
    expected: [verified, inconclusive, inconclusive, verified] },
  { name: 'omitted checkbox action', change: fixture => { fixture.actions.splice(2, 1); },
    expected: [verified, verified, inconclusive, verified] },
  { name: 'menu action with wrong target witness', change: fixture => {
    fixture.actions[0]!.targetWitness!.target = { kind: 'role_name', role: 'button', name: 'Other' };
    fixture.actions[0]!.validatedTarget = JSON.stringify(fixture.actions[0]!.targetWitness!.target);
  }, expected: [inconclusive, inconclusive, inconclusive, verified] },
  { name: 'menu action with wrong operation', change: fixture => {
    fixture.actions[0]!.operation = 'check';
  }, expected: [inconclusive, inconclusive, inconclusive, verified] },
  { name: 'menu action attributed to wrong goal', change: fixture => {
    fixture.actions[0]!.goalId = 'other';
  }, expected: [inconclusive, inconclusive, inconclusive, verified] },
  { name: 'menu receipt without observed effect', change: fixture => {
    fixture.actions[0]!.observedEffect = undefined;
  }, expected: [inconclusive, inconclusive, inconclusive, verified] },
  { name: 'menu predicate unknown before action', change: fixture => {
    fixture.observations[0]!.dom.complete = false;
  }, expected: [inconclusive, inconclusive, inconclusive, verified] },
  { name: 'navigation recorded before its prerequisite', change: fixture => {
    fixture.actions.splice(0, 2, fixture.actions[1]!, fixture.actions[0]!);
  }, expected: [verified, inconclusive, inconclusive, verified] },
  { name: 'unrelated exploratory receipt alongside valid chain', change: fixture => {
    const unrelated = { ...fixture.actions[0]!, evidenceId: 'unrelated', goalId: 'panel_hint' };
    fixture.actions.unshift(unrelated);
  }, expected: [verified, verified, verified, verified] },
  { name: 'predecessor and dependent actions from different sessions', change: fixture => {
    const menuB = structuredClone(fixture.observations[1]!);
    const preferencesB = structuredClone(fixture.observations[2]!);
    const checkedB = structuredClone(fixture.observations[3]!);
    menuB.observationId = 'menuB'; preferencesB.observationId = 'preferencesB';
    checkedB.observationId = 'checkedB';
    for (const item of [menuB, preferencesB, checkedB]) item.sessionId = 'other_session';
    fixture.observations.splice(2, 2, menuB, preferencesB, checkedB);
    fixture.actions.splice(1, 2,
      fixture.receipt('chain1', 'click', menuB, preferencesB, 'link', 'Preferences'),
      fixture.receipt('chain2', 'check', preferencesB, checkedB, 'checkbox', 'Reminders'));
  }, expected: [inconclusive, inconclusive, inconclusive, inconclusive] },
];
for (const { name, change, expected } of chainCases) test(`causal chain: ${name}`, () => {
  const fixture = genericChain();
  change(fixture);
  expect(verifyAcceptedRequirements(fixture.intake, fixture.observations, fixture.actions)
    .coverage.map(item => item.status)).toEqual(expected);
});

test('intake binds all authored clauses after observation and clean action causality proves navigation', () => {
  const home = observation('home', '/');
  const settings = observation('settings', '/settings', false);
  const enabled = observation('enabled', '/settings', true);
  const reload = observation('reload', '/settings', true);
  const intake = validateRequirementIntake(task, home,
    { ledger, acceptancePlan: plan(home.observationId) }, [home]);
  const grounded = promoteGroundedAcceptance(intake, [home, settings, enabled]);
  expect(grounded.acceptancePlan.goals.every(goal => goal.status === 'grounded')).toBe(true);
  const verified = verifyAcceptedRequirements(grounded, [home, settings, enabled, reload],
    [action('g0', 'click', home, settings), action('g1', 'check', settings, enabled)]);
  expect(verified.coverage.map(item => item.status)).toEqual([
    'verified_true', 'verified_true', 'verified_true']);
  expect(verified.trusted.size).toBe(3);
});

test('a source-bound destination is grounded while false and remains false if never reached', () => {
  const home = observation('home', '/');
  const candidate: RequirementAcceptancePlanV1 = plan(home.observationId);
  candidate.goals[0]!.status = 'grounded';
  candidate.goals[0]!.predicates = [{ kind: 'url', comparison: 'path_equals', value: '/preferences' }];
  const intake = validateRequirementIntake(task, home,
    { ledger, acceptancePlan: candidate }, [home]);
  expect(intake.acceptancePlan.goals[0]?.status).toBe('grounded');
  expect(evaluateAcceptancePredicate(candidate.goals[0]!.predicates[0]!, home)).toBe('false');
  expect(verifyAcceptedRequirements(intake, [home], []).coverage[0]?.status).toBe('inconclusive');
  const assertion = structuredClone(intake);
  assertion.acceptancePlan.goals[0]!.kind = 'assertion';
  assertion.acceptancePlan.goals[0]!.action = undefined;
  expect(verifyAcceptedRequirements(assertion, [home], []).coverage[0]?.status).toBe('verified_false');
});

test('an absent destination control can become observable after navigation', () => {
  const home = observation('home', '/');
  const candidate: RequirementAcceptancePlanV1 = plan(home.observationId);
  candidate.goals[2]!.status = 'hypothesis';
  candidate.goals[2]!.predicates = [{ kind: 'element', role: 'checkbox',
    name: 'Email notifications', property: 'checked', equals: true }];
  const intake = validateRequirementIntake(task, home,
    { ledger, acceptancePlan: candidate }, [home]);
  expect(promoteGroundedAcceptance(intake, [home]).acceptancePlan.goals[2]?.status).toBe('hypothesis');
  const settings = observation('settings', '/settings', false);
  const promoted = promoteGroundedAcceptance(intake, [home, settings]);
  expect(promoted.acceptancePlan.goals[2]?.status).toBe('grounded');
  expect(evaluateAcceptancePredicate(candidate.goals[2]!.predicates[0]!, settings)).toBe('false');
  expect(verifyAcceptedRequirements(promoted, [home, settings], []).coverage[2]?.status)
    .toBe('verified_false');
});

test('a named control with an absent property does not become observable', () => {
  const home = observation('home', '/');
  const candidate: RequirementAcceptancePlanV1 = plan(home.observationId);
  candidate.goals[1]!.predicates = [{ kind: 'element', role: 'button', name: 'Settings',
    property: 'checked', equals: true }];
  candidate.goals[1]!.status = 'grounded';
  expect(() => validateRequirementIntake(task, home,
    { ledger, acceptancePlan: candidate }, [home])).toThrow('ACCEPTANCE_NOT_GROUNDED');
  candidate.goals[1]!.status = 'hypothesis';
  const intake = validateRequirementIntake(task, home,
    { ledger, acceptancePlan: candidate }, [home]);
  expect(promoteGroundedAcceptance(intake, [home]).acceptancePlan.goals[1]?.status).toBe('hypothesis');
});

test('intake rejects missing authored text, unobservable grounding, and unsupported vocabulary', () => {
  const home = observation('home', '/');
  const valid = { ledger, acceptancePlan: plan(home.observationId) };
  expect(() => validateRequirementIntake(task, home, { ...valid,
    ledger: { ...ledger, authoredGoals: ledger.authoredGoals.slice(0, 2) },
    acceptancePlan: { ...valid.acceptancePlan, goals: valid.acceptancePlan.goals.slice(0, 2) } },
  [home])).toThrow('REQUIREMENT_INTAKE_INVALID');
  expect(() => validateRequirementIntake(task, home, { ...valid,
    acceptancePlan: { ...valid.acceptancePlan, goals: valid.acceptancePlan.goals.map((goal, index) =>
      index === 1 ? { ...goal, status: 'grounded' } : goal) } }, [home])).toThrow('ACCEPTANCE_NOT_GROUNDED');
  expect(() => validateRequirementIntake(task, home, { ...valid,
    acceptancePlan: { ...valid.acceptancePlan, goals: valid.acceptancePlan.goals.map((goal, index) =>
      index === 0 ? { ...goal, predicates: [{ kind: 'script', value: 'true' }] } : goal) } },
  [home])).toThrow();
});

test('clean verifier treats action receipts and broken ordering as inconclusive', () => {
  const home = observation('home', '/');
  const settings = observation('settings', '/settings', false);
  const enabled = observation('enabled', '/settings', true);
  const intake = promoteGroundedAcceptance(validateRequirementIntake(task, home,
    { ledger, acceptancePlan: plan(home.observationId) }, [home]), [home, settings]);
  const noAction = verifyAcceptedRequirements(intake, [home, settings, enabled], []);
  expect(noAction.coverage[0]?.status).toBe('inconclusive');
  const noTransition = verifyAcceptedRequirements(intake, [home, settings, enabled],
    [action('g0', 'click', settings, settings)]);
  expect(noTransition.coverage[0]?.status).toBe('inconclusive');
  const orderedPlan = structuredClone(intake);
  orderedPlan.acceptancePlan.goals[0]!.action!.afterGoalIds = ['g1'];
  const wrongOrder = verifyAcceptedRequirements(orderedPlan, [home, settings, enabled],
    [action('g0', 'click', home, settings), action('g1', 'check', settings, enabled)]);
  expect(wrongOrder.coverage[0]?.status).toBe('inconclusive');
});

test('a dependent action requires its predecessor to pass target and transition proof', () => {
  const home = observation('home', '/');
  const settings = observation('settings', '/settings', false);
  const enabled = observation('enabled', '/settings', true);
  const actionLedger = structuredClone(ledger);
  actionLedger.authoredGoals[1]!.kind = 'required_action';
  const candidate: RequirementAcceptancePlanV1 = plan(home.observationId);
  candidate.goals[1]!.kind = 'required_action';
  candidate.goals[1]!.action = { operation: 'check', afterGoalIds: ['g0'] };
  const intake = promoteGroundedAcceptance(validateRequirementIntake(task, home,
    { ledger: actionLedger, acceptancePlan: candidate }, [home]), [home, settings]);
  const predecessor = action('g0', 'click', home, settings);
  predecessor.targetWitness!.target = { kind: 'role_name', role: 'button', name: 'Wrong control' };
  predecessor.validatedTarget = JSON.stringify(predecessor.targetWitness!.target);
  const dependent = action('g1', 'check', settings, enabled);
  const coverage = verifyAcceptedRequirements(intake, [home, settings, enabled],
    [predecessor, dependent]).coverage;
  expect(coverage[0]?.status).toBe('inconclusive');
  expect(coverage[1]?.status).toBe('inconclusive');
  const proved = verifyAcceptedRequirements(intake, [home, settings, enabled],
    [action('g0', 'click', home, settings), dependent]).coverage;
  expect(proved[0]?.status).toBe('verified_true');
  expect(proved[1]?.status).toBe('verified_true');
});

test('dependency intake rejects non-action, inferred, and cyclic references', () => {
  const home = observation('home', '/');
  const actionLedger = structuredClone(ledger);
  actionLedger.authoredGoals[1]!.kind = 'required_action';
  actionLedger.inferredPrerequisites.push({ id: 'menu_hint', description: 'Open a menu first',
    supportsGoalIds: ['g1'] });
  const candidate: RequirementAcceptancePlanV1 = plan(home.observationId);
  candidate.goals[1]!.kind = 'required_action';
  candidate.goals[1]!.action = { operation: 'check', afterGoalIds: ['g2'] };
  const raw = { ledger: actionLedger, acceptancePlan: candidate };
  expect(() => validateRequirementIntake(task, home, raw, [home]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  candidate.goals[1]!.action.afterGoalIds = ['menu_hint'];
  expect(() => validateRequirementIntake(task, home, raw, [home]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  candidate.goals[1]!.action.afterGoalIds = ['g0'];
  candidate.goals[0]!.action!.afterGoalIds = ['g1'];
  expect(() => validateRequirementIntake(task, home, raw, [home]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  candidate.goals[0]!.action!.afterGoalIds = [];
  expect(() => validateRequirementIntake(task, home, raw, [home])).not.toThrow();
});

test('refinement cannot rewrite an authored or grounded obligation', () => {
  const home = observation('home', '/');
  const settings = observation('settings', '/settings', false);
  const first = promoteGroundedAcceptance(validateRequirementIntake(task, home,
    { ledger, acceptancePlan: plan(home.observationId) }, [home]), [home, settings]);
  const changed = plan(settings.observationId);
  changed.goals[0]!.predicates[0] = { kind: 'url', comparison: 'path_equals', value: '/profile' };
  expect(() => validateRequirementIntake(task, settings,
    { ledger, acceptancePlan: changed }, [home, settings], first)).toThrow('GROUNDED_ACCEPTANCE_CHANGED');
});

test('intake rejects collapsed clauses, invented goals, and model fulfillment claims', () => {
  const home = observation('home', '/');
  const collapsed = { ...ledger, authoredGoals: [{ ...ledger.authoredGoals[0]!,
    sourceSpan: { start: 0, end: instruction.length }, requirement: instruction }] };
  expect(() => validateRequirementIntake(task, home, { ledger: collapsed,
    acceptancePlan: { ...plan(home.observationId), goals: [{ ...plan(home.observationId).goals[0],
      sourceSpan: collapsed.authoredGoals[0]!.sourceSpan, requirement: instruction }] } },
  [home])).toThrow('REQUIREMENT_INTAKE_INVALID');
  const invented = { ...ledger, authoredGoals: [...ledger.authoredGoals,
    { ...ledger.authoredGoals[0]!, goalId: 'invented' }] };
  expect(() => validateRequirementIntake(task, home, { ledger: invented,
    acceptancePlan: { ...plan(home.observationId), goals: [...plan(home.observationId).goals,
      { ...plan(home.observationId).goals[0]!, goalId: 'invented' }] } }, [home])).toThrow('REQUIREMENT_INTAKE_INVALID');
  const selfReported = { ...ledger, authoredGoals: ledger.authoredGoals.map((goal, index) =>
    index === 0 ? { ...goal, fulfillment: 'observed_true', evidenceRefs: ['model_claim'] } : goal) };
  expect(() => validateRequirementIntake(task, home,
    { ledger: selfReported, acceptancePlan: plan(home.observationId) }, [home]))
    .toThrow('MODEL_GOAL_SELF_REPORT');
});

test('bounded DOM evidence controls exact count and negative existence', () => {
  const page = observation('home', '/');
  const truncated = { ...page, dom: { ...page.dom, complete: false } };
  const count = { kind: 'element' as const, role: 'button', name: 'Settings',
    property: 'count' as const, equals: 1 };
  const absent = { kind: 'element' as const, role: 'button', name: 'Unseen',
    property: 'exists' as const, equals: false };
  expect(evaluateAcceptancePredicate(count, truncated)).toBe('unknown');
  expect(evaluateAcceptancePredicate(absent, truncated)).toBe('unknown');
  expect(evaluateAcceptancePredicate(count, page)).toBe('true');
  expect(evaluateAcceptancePredicate(absent, page)).toBe('true');
});

test('unsupported assertion remains authored and inconclusive pending bounded refinement', () => {
  const home = observation('home', '/');
  const unresolved: RequirementAcceptancePlanV1 = plan(home.observationId);
  unresolved.goals[2]!.status = 'needs_refinement';
  unresolved.goals[2]!.predicates = [];
  const intake = validateRequirementIntake(task, home,
    { ledger, acceptancePlan: unresolved }, [home]);
  const settings = observation('settings', '/settings', false);
  const enabled = observation('enabled', '/settings', true);
  const promoted = promoteGroundedAcceptance(intake, [home, settings, enabled]);
  expect(promoted.acceptancePlan.goals[2]?.status).toBe('needs_refinement');
  expect(verifyAcceptedRequirements(promoted, [home, settings, enabled],
    [action('g0', 'click', home, settings)]).coverage[2]?.status).toBe('inconclusive');
});

test('wrong clean target witness cannot prove a required action', () => {
  const home = observation('home', '/');
  const settings = observation('settings', '/settings', false);
  const intake = promoteGroundedAcceptance(validateRequirementIntake(task, home,
    { ledger, acceptancePlan: plan(home.observationId) }, [home]), [home, settings]);
  const wrong = action('g0', 'click', home, settings);
  wrong.targetWitness!.target = { kind: 'role_name', role: 'button', name: 'Unseen control' };
  expect(verifyAcceptedRequirements(intake, [home, settings], [wrong]).coverage[0]?.status)
    .toBe('inconclusive');
});

test('forbidden action constraint checks the complete clean action sequence', () => {
  const authoredInstruction = 'Open Settings, and never click Delete account.';
  const constrainedTask = { ...task, authoredInstruction, authoredDigest: authoredDigest(authoredInstruction) };
  const phrases = ['Open Settings', 'never click Delete account'];
  const goals = phrases.map((requirement, index) => ({ goalId: `c${index}`,
    kind: index === 0 ? 'required_action' as const : 'constraint' as const,
    requirement, sourceSpan: { start: authoredInstruction.indexOf(requirement),
      end: authoredInstruction.indexOf(requirement) + requirement.length },
    interpretationStatus: 'literal' as const, fulfillment: 'pending' as const, evidenceRefs: [] }));
  const constrainedLedger = { version: '1' as const, taskId: task.taskId,
    authoredDigest: constrainedTask.authoredDigest, authoredGoals: goals,
    inferredPrerequisites: [], unresolvedQuestions: [] };
  const home = observation('home', '/');
  home.dom.elements.push({ ref: 'delete', role: 'button', name: 'Delete account', enabled: true,
    bounds: { x: 200, y: 20, width: 120, height: 24 } });
  const settings = observation('settings', '/settings', false);
  const intake = promoteGroundedAcceptance(validateRequirementIntake(constrainedTask, home,
    { ledger: constrainedLedger, acceptancePlan: { version: '1', taskId: task.taskId,
      authoredDigest: constrainedTask.authoredDigest, sourceObservationId: home.observationId,
      goals: [
        { ...acceptedGoal(goals[0]!), status: 'hypothesis', predicates: [
          { kind: 'url', comparison: 'path_equals', value: '/settings' }],
          action: { operation: 'click', afterGoalIds: [] } },
        { ...acceptedGoal(goals[1]!), status: 'grounded', predicates: [],
          constraint: { kind: 'forbid_action', operation: 'click',
            target: { role: 'button', name: 'Delete account' } } },
      ] } }, [home]), [home, settings]);
  expect(verifyAcceptedRequirements(intake, [home, settings],
    [action('c0', 'click', home, settings)]).coverage.map(item => item.status))
    .toEqual(['verified_true', 'verified_true']);
  const forbidden = action('c0', 'click', home, settings);
  forbidden.targetWitness!.target = { kind: 'role_name', role: 'button', name: 'Delete account' };
  forbidden.validatedTarget = JSON.stringify(forbidden.targetWitness!.target);
  expect(verifyAcceptedRequirements(intake, [home, settings], [forbidden]).coverage[1]?.status)
    .toBe('verified_false');
  const weakened = structuredClone(intake);
  weakened.ledger.authoredGoals[1]!.kind = 'outcome';
  weakened.acceptancePlan.goals[1]!.kind = 'outcome';
  weakened.acceptancePlan.goals[1]!.constraint = undefined;
  weakened.acceptancePlan.goals[1]!.predicates = [
    { kind: 'element', role: 'button', name: 'Delete account', property: 'exists', equals: true }];
  expect(() => validateRequirementIntake(constrainedTask, home, weakened, [home, settings]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  const wrongOperation = structuredClone(intake);
  wrongOperation.acceptancePlan.sourceObservationId = home.observationId;
  wrongOperation.acceptancePlan.goals[1]!.constraint = { kind: 'forbid_action',
    operation: 'scroll', target: { role: 'button', name: 'Delete account' } };
  expect(() => validateRequirementIntake(constrainedTask, home, wrongOperation, [home, settings]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
});

test('standalone required-order constraint rejects reversed clean action sequence', () => {
  const authoredInstruction = 'Open Settings, enable email notifications, and do those actions in order.';
  const orderedTask = { ...task, authoredInstruction, authoredDigest: authoredDigest(authoredInstruction) };
  const phrases = ['Open Settings', 'enable email notifications', 'do those actions in order'];
  const goals = phrases.map((requirement, index) => ({ goalId: `r${index}`,
    kind: index === 2 ? 'constraint' as const : 'required_action' as const,
    requirement, sourceSpan: { start: authoredInstruction.indexOf(requirement),
      end: authoredInstruction.indexOf(requirement) + requirement.length },
    interpretationStatus: 'literal' as const, fulfillment: 'pending' as const, evidenceRefs: [] }));
  const orderedLedger = { version: '1' as const, taskId: task.taskId,
    authoredDigest: orderedTask.authoredDigest, authoredGoals: goals,
    inferredPrerequisites: [], unresolvedQuestions: [] };
  const home = observation('home', '/'), settings = observation('settings', '/settings', false);
  const enabled = observation('enabled', '/settings', true);
  const intake = promoteGroundedAcceptance(validateRequirementIntake(orderedTask, home,
    { ledger: orderedLedger, acceptancePlan: { version: '1', taskId: task.taskId,
      authoredDigest: orderedTask.authoredDigest, sourceObservationId: home.observationId,
      goals: [
        { ...acceptedGoal(goals[0]!), status: 'hypothesis', predicates: [
          { kind: 'url', comparison: 'path_equals', value: '/settings' }],
          action: { operation: 'click', afterGoalIds: [] } },
        { ...acceptedGoal(goals[1]!), status: 'hypothesis', predicates: [
          { kind: 'element', role: 'checkbox', name: 'Email notifications',
            property: 'checked', equals: true }], action: { operation: 'check', afterGoalIds: [] } },
        { ...acceptedGoal(goals[2]!), status: 'grounded', predicates: [],
          constraint: { kind: 'required_order', beforeGoalId: 'r0', afterGoalId: 'r1' } },
      ] } }, [home]), [home, settings, enabled]);
  const first = action('r0', 'click', home, settings), second = action('r1', 'check', settings, enabled);
  expect(verifyAcceptedRequirements(intake, [home, settings, enabled], [first, second])
    .coverage.map(item => item.status)).toEqual(['verified_true', 'verified_true', 'verified_true']);
  expect(verifyAcceptedRequirements(intake, [home, settings, enabled], [second, first])
    .coverage[2]?.status).toBe('verified_false');
  const invalidFirst = action('r0', 'click', home, settings);
  invalidFirst.targetWitness!.target = { kind: 'role_name', role: 'button', name: 'Wrong control' };
  invalidFirst.validatedTarget = JSON.stringify(invalidFirst.targetWitness!.target);
  expect(verifyAcceptedRequirements(intake, [home, settings, enabled], [invalidFirst, second])
    .coverage[2]?.status).toBe('inconclusive');
  const reversed = structuredClone(intake);
  reversed.acceptancePlan.sourceObservationId = home.observationId;
  reversed.acceptancePlan.goals[2]!.constraint = { kind: 'required_order',
    beforeGoalId: 'r1', afterGoalId: 'r0' };
  expect(() => validateRequirementIntake(orderedTask, home, reversed, [home, settings, enabled]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  const disguised = structuredClone(intake);
  disguised.acceptancePlan.sourceObservationId = home.observationId;
  disguised.acceptancePlan.goals[2]!.constraint = { kind: 'forbid_action', operation: 'scroll' };
  expect(() => validateRequirementIntake(orderedTask, home, disguised, [home, settings, enabled]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
});

test('explicit then clause requires an authored predecessor dependency', () => {
  const authoredInstruction = 'Open Settings, then enable email notifications.';
  const orderedTask = { ...task, authoredInstruction, authoredDigest: authoredDigest(authoredInstruction) };
  const phrases = ['Open Settings', 'then enable email notifications'];
  const goals = phrases.map((requirement, index) => ({ goalId: `t${index}`,
    kind: 'required_action' as const, requirement,
    sourceSpan: { start: authoredInstruction.indexOf(requirement),
      end: authoredInstruction.indexOf(requirement) + requirement.length },
    interpretationStatus: 'literal' as const, fulfillment: 'pending' as const, evidenceRefs: [] }));
  const home = observation('home', '/');
  const acceptancePlan = { version: '1', taskId: task.taskId,
    authoredDigest: orderedTask.authoredDigest, sourceObservationId: home.observationId,
    goals: [
      { ...acceptedGoal(goals[0]!), status: 'hypothesis',
        predicates: [{ kind: 'url', comparison: 'path_equals', value: '/settings' }],
        action: { operation: 'click', afterGoalIds: [] as string[] } },
      { ...acceptedGoal(goals[1]!), status: 'hypothesis',
        predicates: [{ kind: 'element', role: 'checkbox', name: 'Email notifications',
          property: 'checked', equals: true }], action: { operation: 'check', afterGoalIds: [] as string[] } },
    ] };
  const orderedLedger = { version: '1', taskId: task.taskId,
    authoredDigest: orderedTask.authoredDigest, authoredGoals: goals,
    inferredPrerequisites: [], unresolvedQuestions: [] };
  expect(() => validateRequirementIntake(orderedTask, home,
    { ledger: orderedLedger, acceptancePlan }, [home])).toThrow('REQUIREMENT_INTAKE_INVALID');
  acceptancePlan.goals[1]!.action.afterGoalIds = ['t0'];
  expect(() => validateRequirementIntake(orderedTask, home,
    { ledger: orderedLedger, acceptancePlan }, [home])).not.toThrow();
});

test('a forbidden click cannot be disguised as an ordering constraint', () => {
  const authoredInstruction = 'Open Settings, enable email notifications, and do not click Delete account.';
  const constrainedTask = { ...task, authoredInstruction, authoredDigest: authoredDigest(authoredInstruction) };
  const phrases = ['Open Settings', 'enable email notifications', 'do not click Delete account'];
  const goals = phrases.map((requirement, index) => ({ goalId: `x${index}`,
    kind: index === 2 ? 'constraint' as const : 'required_action' as const,
    requirement, sourceSpan: { start: authoredInstruction.indexOf(requirement),
      end: authoredInstruction.indexOf(requirement) + requirement.length },
    interpretationStatus: 'literal' as const, fulfillment: 'pending' as const, evidenceRefs: [] }));
  const home = observation('home', '/');
  const accepted: RequirementAcceptancePlanV1['goals'] = [
    { ...acceptedGoal(goals[0]!), status: 'hypothesis', predicates: [
      { kind: 'url', comparison: 'path_equals', value: '/settings' }],
      action: { operation: 'click', afterGoalIds: [] } },
    { ...acceptedGoal(goals[1]!), status: 'hypothesis', predicates: [
      { kind: 'element', role: 'checkbox', name: 'Email notifications',
        property: 'checked', equals: true }], action: { operation: 'check', afterGoalIds: [] } },
    { ...acceptedGoal(goals[2]!), status: 'grounded', predicates: [],
      constraint: { kind: 'required_order', beforeGoalId: 'x0', afterGoalId: 'x1' } },
  ];
  const candidate = { ledger: { version: '1', taskId: task.taskId,
    authoredDigest: constrainedTask.authoredDigest, authoredGoals: goals,
    inferredPrerequisites: [], unresolvedQuestions: [] },
    acceptancePlan: { version: '1', taskId: task.taskId,
      authoredDigest: constrainedTask.authoredDigest,
      sourceObservationId: home.observationId, goals: accepted } };
  expect(() => validateRequirementIntake(constrainedTask, home, candidate, [home]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  accepted[2]!.status = 'needs_refinement';
  expect(() => validateRequirementIntake(constrainedTask, home, candidate, [home]))
    .toThrow('REQUIREMENT_INTAKE_INVALID');
  accepted[2]!.constraint = undefined;
  expect(() => validateRequirementIntake(constrainedTask, home, candidate, [home]))
    .not.toThrow();
});

test('visual-coordinate witness requires a unique observed control under the click', () => {
  const home = observation('home', '/');
  home.dom.elements[0]!.visual = { kind: 'svg_icon', context: 'header' };
  home.screenshot = { ref: 'screen', sessionId: home.sessionId, pageId: home.pageId,
    documentRevision: home.documentRevision, coordinateFrameId: home.coordinateFrameId,
    viewport: home.viewport, observedAt: home.observedAt, scrollX: 0, scrollY: 0 };
  const settings = observation('settings', '/settings', false);
  const intake = promoteGroundedAcceptance(validateRequirementIntake(task, home,
    { ledger, acceptancePlan: plan(home.observationId) }, [home]), [home, settings]);
  const click = action('g0', 'click', home, settings);
  click.targetWitness!.target = { kind: 'visual_coordinate', screenshotRef: 'screen',
    coordinateFrameId: home.coordinateFrameId, viewport: home.viewport,
    x: 700, y: 500, description: 'gear', context: 'header' };
  click.validatedTarget = JSON.stringify(click.targetWitness!.target);
  click.demonstratedTargets = [{ kind: 'visual_anchor', description: 'gear', context: 'header' }];
  expect(verifyAcceptedRequirements(intake, [home, settings], [click]).coverage[0]?.status)
    .toBe('inconclusive');
});

test('required action cannot claim causality when its before property was unknown', () => {
  const home = observation('home', '/');
  home.dom.complete = false;
  const settings = observation('settings', '/settings', false);
  settings.dom.elements.push({ ref: 'security', role: 'link', name: 'Security', enabled: true,
    bounds: { x: 200, y: 30, width: 90, height: 24 } });
  const candidate: RequirementAcceptancePlanV1 = plan(home.observationId);
  candidate.goals[0]!.predicates = [{ kind: 'element', role: 'link', name: 'Security',
    property: 'visible', equals: true }];
  const intake = promoteGroundedAcceptance(validateRequirementIntake(task, home,
    { ledger, acceptancePlan: candidate }, [home]), [home, settings]);
  expect(verifyAcceptedRequirements(intake, [home, settings],
    [action('g0', 'click', home, settings)]).coverage[0]?.status).toBe('inconclusive');
});
