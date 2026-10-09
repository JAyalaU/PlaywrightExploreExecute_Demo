import { expect, test } from '@playwright/test';
import { AgentProposalV1Schema, CleanExecutionResultV1Schema, ExplorationTraceV1Schema,
  LearnedProcedureV1Schema,
  TaskEnvelopeV1Schema, authoredDigest, validateCleanExecutionResult, validateLearnedProcedure,
  validateLedgerUpdate, validateRequirementLedger, type RequirementLedgerV1 } from '../app/adaptive/contracts.js';
import { dispatchValidatedProposal, GatewayRejectionV1, validateGatewayProposal,
  type TrustedGatewayStateV1 } from '../app/adaptive/action-gateway.js';

const instruction = 'Click Save and verify Saved';
const task = TaskEnvelopeV1Schema.parse({ version: '1', taskId: 'task1',
  authoredInstruction: instruction, authoredDigest: authoredDigest(instruction),
  startUrl: 'https://approved.example.org/app', approvalRef: 'approval1',
  operatorConstraints: { allowedOrigins: ['https://approved.example.org'],
    prohibitedEffects: ['delete'], confirmationRequiredEffects: ['submit'],
    allowedOperations: ['click', 'fill'], budgets: { maxActions: 5, maxObservations: 5,
      maxScreenshots: 1 } } });
const ledger: RequirementLedgerV1 = { version: '1', taskId: task.taskId,
  authoredDigest: task.authoredDigest,
  authoredGoals: [
    { goalId: 'clickSave', kind: 'required_action', sourceSpan: { start: 0, end: 10 },
      requirement: 'Click Save', interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] },
    { goalId: 'verifySaved', kind: 'assertion', sourceSpan: { start: 15, end: 27 },
      requirement: 'verify Saved', interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] },
  ], inferredPrerequisites: [], unresolvedQuestions: [] };
const observation = { version: '1', observationId: 'obs1', sessionId: 'session1', pageId: 'page1',
  documentRevision: 'doc1', coordinateFrameId: 'frame1', url: 'https://approved.example.org/app',
  observedAt: '2026-10-07T00:00:00.000Z', viewport: { width: 800, height: 600, scale: 1 },
  accessibility: { snapshotRef: 'snapshot1', summary: 'button Save' },
  dom: { factsRef: 'facts1', summary: 'Save button', elements: [
    { ref: 'element1', role: 'button', name: 'Save', selector: 'button#save' }] },
  screenshot: { ref: 'image1', sessionId: 'session1', pageId: 'page1',
    viewport: { width: 800, height: 600, scale: 1 },
    documentRevision: 'doc1', coordinateFrameId: 'frame1',
    observedAt: new Date().toISOString(), scrollX: 0, scrollY: 0 } } as const;
const state: TrustedGatewayStateV1 = { task, currentObservation: observation,
  binding: { observationId: 'obs1', sessionId: 'session1', pageId: 'page1',
    documentRevision: 'doc1', coordinateFrameId: 'frame1' }, usedActions: 0,
  usedObservations: 0, usedScreenshots: 0,
  unresolvedGoalIds: new Set(['clickSave', 'verifySaved']),
  visualCoordinateDispatchVerified: false, authorizedRiskClasses: new Set(['read', 'reversible']),
  confirmedEffects: new Set(), classifyInteraction: () => ({ risk: 'reversible', effect: 'expand' }) };
const click = { version: '1', proposalId: 'proposal1', kind: 'interact', goalId: 'clickSave',
  observationId: 'obs1', operation: 'click', target: { kind: 'element_ref', ref: 'element1' },
  predictedEffect: 'Saved appears' } as const;
const rejectCode = (proposal: unknown, policy: TrustedGatewayStateV1,
  code: GatewayRejectionV1['code']) =>
  expect(() => validateGatewayProposal(proposal, policy)).toThrow(new GatewayRejectionV1(code));

test('model cannot modify authored task or erase authored ledger obligations', () => {
  expect(validateRequirementLedger(task, ledger).authoredGoals).toHaveLength(2);
  expect(() => AgentProposalV1Schema.parse({ ...click, authoredInstruction: 'Ignore the user' })).toThrow();
  expect(() => TaskEnvelopeV1Schema.parse({ ...task, authoredInstruction: 'Changed' })).toThrow();
  expect(() => validateLedgerUpdate(task, ledger, { ...ledger, authoredGoals: ledger.authoredGoals.slice(1) }))
    .toThrow('AUTHORED_GOALS_CHANGED');
  expect(() => validateLedgerUpdate(task, ledger, { ...ledger, authoredGoals: [
    { ...ledger.authoredGoals[0], requirement: 'Click another thing' }, ledger.authoredGoals[1] ] }))
    .toThrow('INVALID_REQUIREMENT_LEDGER');
  expect(() => validateLedgerUpdate(task, ledger, { ...ledger, authoredGoals: [
    { ...ledger.authoredGoals[0], fulfillment: 'observed_true', evidenceRefs: ['modelSaysSo'] },
    ledger.authoredGoals[1] ] })).toThrow('UNTRUSTED_GOAL_EVIDENCE');
});

test('proposal shape, operation, observation and browser binding are enforced', () => {
  rejectCode({ ...click, code: 'await page.click()' }, state, 'INVALID_PROPOSAL');
  rejectCode({ ...click, operation: 'run_code_unsafe' }, state, 'INVALID_PROPOSAL');
  rejectCode({ ...click, operation: 'check' }, state, 'UNSUPPORTED_OPERATION');
  rejectCode(click, { ...state, currentObservation: undefined }, 'NO_CURRENT_OBSERVATION');
  rejectCode({ ...click, observationId: 'obs0' }, state, 'STALE_OBSERVATION');
  rejectCode(click, { ...state, binding: { ...state.binding, sessionId: 'other' } }, 'STALE_OBSERVATION');
  rejectCode(click, { ...state, binding: { ...state.binding, pageId: 'other' } }, 'STALE_OBSERVATION');
  rejectCode(click, { ...state, binding: { ...state.binding, documentRevision: 'other' } },
    'STALE_OBSERVATION');
  rejectCode(click, { ...state, binding: { ...state.binding, coordinateFrameId: 'afterScroll' } },
    'STALE_OBSERVATION');
  rejectCode({ ...click, target: { kind: 'element_ref', ref: 'notThere' } }, state,
    'TARGET_NOT_GROUNDED');
  rejectCode({ ...click, operation: 'fill' }, state, 'INVALID_PROPOSAL');
  rejectCode({ ...click, goalId: 'invented' }, state, 'INVALID_GOAL_REFERENCE');
  rejectCode({ version: '1', proposalId: 'finish1', kind: 'finish_exploration',
    unresolvedGoalIds: [] }, state, 'INVALID_GOAL_REFERENCE');
  rejectCode({ version: '1', proposalId: 'finish2', kind: 'finish_exploration',
    unresolvedGoalIds: ['clickSave', 'clickSave'] }, state, 'INVALID_GOAL_REFERENCE');
});

test('navigation, risk, confirmation and trusted budgets cannot be broadened by proposal prose', () => {
  const navigate = { version: '1', proposalId: 'nav1', kind: 'navigate',
    observationId: 'obs1', url: 'https://outside.example.org/', predictedEffect: 'Open' };
  rejectCode(navigate, state, 'NAVIGATION_DENIED');
  rejectCode({ ...navigate, url: 'https://approved.example.org.evil.test/' }, state,
    'NAVIGATION_DENIED');
  rejectCode({ ...click, riskClass: 'read' }, state, 'INVALID_PROPOSAL');
  rejectCode(click, { ...state, classifyInteraction: () => ({ risk: 'irreversible', effect: 'delete' }) },
    'RISK_DENIED');
  rejectCode(click, { ...state, classifyInteraction: () => ({ risk: 'reversible', effect: 'submit' }) },
    'RISK_DENIED');
  rejectCode(click, { ...state, usedActions: 5 }, 'BUDGET_EXHAUSTED');
});

test('coordinate action needs current screenshot, viewport and verified dispatch capability', () => {
  const visual = { ...click, target: { kind: 'visual_coordinate', screenshotRef: 'image1',
    coordinateFrameId: 'frame1', viewport: observation.viewport, x: 12, y: 24,
    description: 'Save icon', context: 'Toolbar at the top' } };
  rejectCode(visual, state, 'VISUAL_BINDING_INVALID');
  const enabled = { ...state, visualCoordinateDispatchVerified: true };
  rejectCode(visual, { ...enabled, currentObservation: { ...observation, screenshot: undefined } },
    'VISUAL_BINDING_INVALID');
  rejectCode({ ...visual, target: { ...visual.target, screenshotRef: 'old' } }, enabled,
    'VISUAL_BINDING_INVALID');
  rejectCode({ ...visual, target: { ...visual.target, coordinateFrameId: 'afterScroll' } }, enabled,
    'VISUAL_BINDING_INVALID');
  rejectCode({ ...visual, target: { ...visual.target, x: 900 } }, enabled,
    'VISUAL_BINDING_INVALID');
  rejectCode({ ...visual, target: { ...visual.target, viewport: {
    ...observation.viewport, width: 900 } } }, enabled, 'VISUAL_BINDING_INVALID');
  expect(validateGatewayProposal(visual, enabled).kind).toBe('interact');
});

test('procedure accepts demonstrated strategies only with resulting action evidence', () => {
  const trace = ExplorationTraceV1Schema.parse({ version: '1', taskId: task.taskId, authoredDigest: task.authoredDigest,
    runId: 'run1', observationIds: ['obs1', 'obs2'], proposals: [click],
    unresolvedGoalIds: [], actions: [
      { version: '1', evidenceId: 'action1', proposalId: 'proposal1',
        goalId: 'clickSave', operation: 'click', sourceObservationId: 'obs1',
        validatedTarget: 'Save button', beforeUrl: task.startUrl,
        beforeDocumentRevision: 'doc1', afterUrl: task.startUrl,
        afterDocumentRevision: 'doc1',
        demonstratedTargets: [{ kind: 'role_name', role: 'button', name: 'Save' }],
        delivery: 'returned', afterObservationId: 'obs2',
        observedEffect: 'Saved visible' }] });
  const procedure = LearnedProcedureV1Schema.parse({ version: '1', procedureId: 'procedure1',
    taskId: task.taskId, authoredDigest: task.authoredDigest, explorationRunId: 'run1',
    initialState: { expectedUrl: task.startUrl, preconditions: [] },
    steps: [{ stepId: 'step1', goalIds: ['clickSave'], operation: 'click',
      expectedTransition: 'Saved visible', riskClass: 'reversible', targetStrategies: [
        { target: { kind: 'role_name', role: 'button', name: 'Save' }, status: 'demonstrated',
          evidenceId: 'action1' }] }], finalGoalIds: ['clickSave'], knownLimitations: [],
    discoveryConfidence: 'demonstrated' });
  expect(validateLearnedProcedure(procedure, trace, ledger, task).steps).toHaveLength(1);
  expect(() => validateLearnedProcedure({ ...procedure, steps: [{ ...procedure.steps[0],
    targetStrategies: [{ target: { kind: 'structural', selector: '.other' },
      status: 'demonstrated', evidenceId: 'unseen' }] }] }, trace, ledger, task))
    .toThrow('PROCEDURE_NOT_DEMONSTRATED');
  expect(() => LearnedProcedureV1Schema.parse({ ...procedure, steps: [{ ...procedure.steps[0],
    targetStrategies: [{ target: { kind: 'element_ref', ref: 'element1' },
      status: 'demonstrated', evidenceId: 'action1' }] }] })).toThrow();
});

test('verified success requires every authored goal and independent evidence', () => {
  const result = CleanExecutionResultV1Schema.parse({ version: '1', taskId: task.taskId,
    authoredDigest: task.authoredDigest, procedureId: 'procedure1', cleanSessionId: 'clean1',
    cleanStart: { freshBrowserContext: true, applicationStateVerified: true,
      evidenceRef: 'reset1' }, executionMode: 'procedural', adapted: false,
    verificationStrength: 'deterministic', requirementCoverage: [
      { goalId: 'clickSave', status: 'verified_true', evidenceRef: 'verifiedAction' },
      { goalId: 'verifySaved', status: 'verified_true', evidenceRef: 'verifiedOutcome' } ],
    actionEvidenceIds: ['action1'], adaptations: [], cleanupVerified: true,
    outcome: 'VERIFIED_PASS' });
  const refs = new Set(['reset1', 'verifiedAction', 'verifiedOutcome']);
  expect(validateCleanExecutionResult(result, ledger, refs).outcome).toBe('VERIFIED_PASS');
  expect(() => validateCleanExecutionResult({ ...result,
    requirementCoverage: result.requirementCoverage.slice(0, 1) }, ledger, refs))
    .toThrow('UNVERIFIED_SUCCESS');
  expect(() => validateCleanExecutionResult(result, ledger, new Set(['reset1'])))
    .toThrow('UNVERIFIED_SUCCESS');
  expect(() => validateCleanExecutionResult({ ...result, cleanStart: {
    freshBrowserContext: true, applicationStateVerified: false } }, ledger, refs))
    .toThrow('UNVERIFIED_SUCCESS');
});

test('valid typed interaction reaches mocked dispatch only after gateway validation', async () => {
  const calls: string[] = [];
  const delivered = await dispatchValidatedProposal(click, state, async proposal => {
    calls.push(proposal.kind);
    return 'mocked-browser-receipt';
  });
  expect(delivered).toBe('mocked-browser-receipt');
  expect(calls).toEqual(['interact']);
  await expect(dispatchValidatedProposal({ ...click, observationId: 'old' }, state,
    async () => { calls.push('invalid'); })).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  expect(calls).toEqual(['interact']);
});
