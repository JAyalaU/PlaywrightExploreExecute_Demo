import { test, expect } from '@playwright/test';
import { authoredDigest, type AgentProposalV1, type RequirementLedgerV1,
  type TaskEnvelopeV1 } from '../app/adaptive/contracts.js';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { runAdaptiveVerticalSlice } from '../app/adaptive/vertical-slice.js';
import type { ReasoningModel } from '../app/adaptive/interfaces.js';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { startPhase3aFixture, type Phase3aFamily } from './support/adaptive-phase3a-fixture.js';

function goal(instruction: string, phrase: string, goalId: string,
  kind: RequirementLedgerV1['authoredGoals'][number]['kind']) {
  const start = instruction.indexOf(phrase);
  if (start < 0) throw new Error('TEST_PHRASE_MISSING');
  return { goalId, kind, requirement: phrase, sourceSpan: { start, end: start + phrase.length },
    interpretationStatus: 'literal' as const, fulfillment: 'pending' as const, evidenceRefs: [] };
}
function task(baseUrl: string, instruction: string): TaskEnvelopeV1 {
  return { version: '1', taskId: 'phase3a_local', authoredInstruction: instruction,
    authoredDigest: authoredDigest(instruction), startUrl: `${baseUrl}/`,
    approvalRef: 'phase3a_local_approved', stateResetRef: 'phase3a_reset',
    operatorConstraints: { allowedOrigins: [baseUrl], prohibitedEffects: [],
      confirmationRequiredEffects: [], allowedOperations: ['click', 'check', 'uncheck'],
      budgets: { maxActions: 8, maxObservations: 15, maxScreenshots: 1 } } };
}
function offlineModel(family: Phase3aFamily, seen: string[]): ReasoningModel {
  let nextId = 0;
  const proposal = (value: object): AgentProposalV1 =>
    ({ version: '1', proposalId: `p${++nextId}`, ...value } as AgentProposalV1);
  return {
    async interpretRequirements(context) {
      const original = context.original.authoredInstruction;
      seen.push(JSON.stringify(context));
      const goals = family === 'activity'
        ? [goal(original, 'Open Activity', 'g0', 'required_action'),
          goal(original, 'verify that the URL path is /activity', 'g1', 'assertion')]
        : [goal(original, 'Open Profile', 'g0', 'required_action'),
          goal(original, 'then Security', 'g1', 'required_action'),
          goal(original, 'enable Login alerts', 'g2', 'required_action'),
          goal(original, 'verify that Login alerts are enabled', 'g3', 'assertion')];
      const ledger: RequirementLedgerV1 = { version: '1', taskId: context.original.taskId,
        authoredDigest: context.original.authoredDigest, authoredGoals: goals,
        inferredPrerequisites: [], unresolvedQuestions: [] };
      const path = new URL(context.observation.url).pathname;
      const hasSecurity = context.observation.dom.elements.some(item =>
        item.role === 'link' && item.name === 'Security');
      const hasAlerts = context.observation.dom.elements.some(item =>
        item.role === 'checkbox' && item.name === 'Login alerts');
      const planGoals = family === 'activity'
        ? [
          { ...goals[0]!, status: path === '/activity' ? 'grounded' as const : 'hypothesis' as const,
            predicates: [{ kind: 'url' as const, comparison: 'path_equals' as const, value: '/activity' }],
            action: { operation: 'click' as const, afterGoalIds: [] } },
          { ...goals[1]!, status: path === '/activity' ? 'grounded' as const : 'hypothesis' as const,
            predicates: [{ kind: 'url' as const, comparison: 'path_equals' as const, value: '/activity' }] },
        ] : [
          { ...goals[0]!, status: hasSecurity ? 'grounded' as const : 'hypothesis' as const,
            predicates: [{ kind: 'element' as const, role: 'link', name: 'Security',
              property: 'visible' as const, equals: true }],
            action: { operation: 'click' as const, afterGoalIds: [] } },
          { ...goals[1]!, status: path === '/security' ? 'grounded' as const : 'hypothesis' as const,
            predicates: [{ kind: 'url' as const, comparison: 'path_equals' as const, value: '/security' }],
            action: { operation: 'click' as const, afterGoalIds: ['g0'] } },
          { ...goals[2]!, status: hasAlerts ? 'grounded' as const : 'hypothesis' as const,
            predicates: [{ kind: 'element' as const, role: 'checkbox', name: 'Login alerts',
              property: 'checked' as const, equals: true }],
            action: { operation: 'check' as const, afterGoalIds: ['g1'] } },
          { ...goals[3]!, status: hasAlerts ? 'grounded' as const : 'hypothesis' as const,
            predicates: [{ kind: 'element' as const, role: 'checkbox', name: 'Login alerts',
              property: 'checked' as const, equals: true }] },
        ];
      return { ledger, acceptancePlan: { version: '1', taskId: context.original.taskId,
        authoredDigest: context.original.authoredDigest,
        sourceObservationId: context.observation.observationId,
        goals: planGoals.map(({ interpretationStatus: _interpretationStatus,
          fulfillment: _fulfillment, evidenceRefs: _evidenceRefs, ...item }) => item) } };
    },
    async propose(context) {
      seen.push(JSON.stringify(context));
      const observation = context.observation;
      const path = new URL(observation.url).pathname;
      const named = (name: string) => observation.dom.elements.find(item => item.name === name);
      const interact = (goalId: string, operation: 'click' | 'check', name: string) =>
        proposal({ kind: 'interact', observationId: observation.observationId,
          goalId, operation, target: { kind: 'role_name', role: named(name)!.role!, name },
          predictedEffect: `${name} state changes` });
      if (family === 'activity' && path === '/') return interact('g0', 'click', 'Activity');
      if (family === 'security') {
        if (path === '/' && !named('Security')) return interact('g0', 'click', 'Profile');
        if (path === '/') return interact('g1', 'click', 'Security');
        const alerts = named('Login alerts');
        if (alerts && !alerts.checked) return interact('g2', 'check', 'Login alerts');
      }
      const verifyGoal = context.unresolvedGoalIds.find(id => family === 'activity'
        ? id === 'g1' : id === 'g2' || id === 'g3');
      if (verifyGoal) return family === 'activity'
        ? proposal({ kind: 'verify', observationId: observation.observationId, goalId: verifyGoal,
          predicate: { kind: 'url', equals: `${new URL(observation.url).origin}/activity` } })
        : proposal({ kind: 'verify', observationId: observation.observationId, goalId: verifyGoal,
          predicate: { kind: 'element_state', target: { kind: 'role_name',
            role: 'checkbox', name: 'Login alerts' }, property: 'checked', equals: true } });
      return proposal({ kind: 'finish_exploration', unresolvedGoalIds: [...context.unresolvedGoalIds] });
    },
  };
}

for (const family of ['activity', 'security'] as const) test(`Phase 3A ${family} task derives requirements after observation and verifies clean execution`, async () => {
  let browsers = 0;
  const fixture = await startPhase3aFixture(family, () => browsers);
  const instruction = family === 'activity'
    ? 'Open Activity and verify that the URL path is /activity.'
    : 'Open Profile, then Security, enable Login alerts, and verify that Login alerts are enabled.';
  const envelope = task(fixture.baseUrl, instruction);
  const seen: string[] = [];
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_phase3a', version: '1',
    browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} },
    profileSchemaVersion: '5', presentationMode: 'headless',
    browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows' }]);
  const factory = new ProtectedContextFactory(catalog);
  try {
    const report = await runAdaptiveVerticalSlice({ task: envelope, model: offlineModel(family, seen),
      reset: fixture.reset, openBrowser: async () => { browsers++;
        const session = await factory.open({ id: 'adaptive_phase3a', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close()); },
      maxModelTurns: 8, maxElapsedMs: 30_000, maxIneffectiveActions: 2 });
    if (report.result.outcome !== 'VERIFIED_PASS') console.log(JSON.stringify({ family,
      stopReason: report.stopReason, proposals: report.trace.proposals.map(item => ({ kind: item.kind,
        goalId: 'goalId' in item ? item.goalId : undefined })),
      coverage: report.result.requirementCoverage, checks: report.explorationChecks,
      actions: report.explorationActions.map(item => ({ goalId: item.goalId,
        operation: item.operation, effect: item.observedEffect })) }));
    expect(report.result.outcome, report.stopReason).toBe('VERIFIED_PASS');
    expect(report.result.requirementCoverage.every(item => item.status === 'verified_true')).toBe(true);
    expect(report.result.cleanStart.applicationStateVerified).toBe(true);
    expect(report.result.cleanupVerified).toBe(true);
    expect(report.procedure?.steps.length).toBe(family === 'activity' ? 1 : 3);
    if (family === 'security') {
      expect((await fixture.oracle()).alertsEnabled).toBe(true);
      expect(report.finalCleanState?.controls.some(item =>
        item.name === 'Login alerts' && item.checked === true)).toBe(true);
      expect(report.result.actionEvidenceIds).toHaveLength(3);
    }
    expect(seen.join('\n')).not.toContain('alertsEnabled');
    expect(seen.join('\n')).not.toContain('resetGeneration');
  } finally { await fixture.close(); }
});

async function runActivityWithModel(makeModel: (baseUrl: string) => ReasoningModel,
  diagnostics = false) {
  let browsers = 0;
  const fixture = await startPhase3aFixture('activity', () => browsers);
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_phase3a', version: '1',
    browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} },
    profileSchemaVersion: '5', presentationMode: 'headless',
    browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows' }]);
  const factory = new ProtectedContextFactory(catalog);
  try {
    return await runAdaptiveVerticalSlice({ task: task(fixture.baseUrl,
      'Open Activity and verify that the URL path is /activity.'),
    model: makeModel(fixture.baseUrl), reset: fixture.reset,
    openBrowser: async () => { browsers++;
      const session = await factory.open({ id: 'adaptive_phase3a', version: '1' });
      return new AdaptiveBrowser(await session.context.newPage(), () => session.close()); },
    maxModelTurns: 7, maxElapsedMs: 30_000, maxIneffectiveActions: 2, diagnostics });
  } finally { await fixture.close(); }
}

test('negative verification feedback lets the model recover with a productive action', async () => {
  let received = false;
  const report = await runActivityWithModel(baseUrl => {
    const model = offlineModel('activity', []);
    return { ...model, async propose(context) {
      if (!context.verificationFeedback?.length) return { version: '1', proposalId: 'earlycheck',
        kind: 'verify', observationId: context.observation.observationId, goalId: 'g1',
        predicate: { kind: 'url', equals: `${baseUrl}/activity` } };
      if (context.verificationFeedback[0]?.observedResult === 'false' &&
          context.verificationFeedback[0]?.reason === 'observed_false') received = true;
      return model.propose(context);
    } };
  }, true);
  expect(received).toBe(true);
  expect(report.result.outcome, report.stopReason).toBe('VERIFIED_PASS');
  expect(report.diagnostics?.verifications[0]).toMatchObject({ observedResult: 'false',
    matchesAcceptance: true, progressAfter: { coverage: 'verified_false', explicitlyVerified: false } });
  expect(report.diagnostics?.firstTerminalFailure).toBeUndefined();
});

test('repeated identical ineffective verification stops after actionable feedback', async () => {
  let feedbackSeen = 0, proposals = 0;
  const report = await runActivityWithModel(baseUrl => {
    const model = offlineModel('activity', []);
    return { ...model, async propose(context) {
      feedbackSeen = Math.max(feedbackSeen, context.verificationFeedback?.length ?? 0);
      return { version: '1', proposalId: `repeat${++proposals}`, kind: 'verify',
        observationId: context.observation.observationId, goalId: 'g1',
        predicate: { kind: 'url', equals: `${baseUrl}/activity` } };
    } };
  }, true);
  expect(report.stopReason).toBe('REPEATED_INEFFECTIVE_VERIFICATION');
  expect(feedbackSeen).toBeGreaterThan(0);
  expect(report.diagnostics?.verifications.map(item => item.newEvidence)).toEqual([true, false, false]);
  expect(report.diagnostics?.firstTerminalFailure).toBe('REPEATED_INEFFECTIVE_VERIFICATION');
});

test('true verification without its required action reports missing causal evidence', async () => {
  let proposals = 0;
  const report = await runActivityWithModel(baseUrl => {
    const model = offlineModel('activity', []);
    return { ...model, async propose(context) {
      if (++proposals === 1) return { version: '1', proposalId: 'wronggoalnav',
        kind: 'navigate', observationId: context.observation.observationId,
        goalId: 'g1', url: `${baseUrl}/activity`, predictedEffect: 'destination opens' };
      if (proposals === 2) return { version: '1', proposalId: 'truecheck',
        kind: 'verify', observationId: context.observation.observationId, goalId: 'g1',
        predicate: { kind: 'url', equals: `${baseUrl}/activity` } };
      return { version: '1', proposalId: `stop${proposals}`,
        kind: 'request_clarification', question: 'Action proof missing', blockingGoalIds: ['g0'] };
    } };
  }, true);
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.diagnostics?.verifications[0]).toMatchObject({ observedResult: 'true',
    matchesAcceptance: true, missingActionEvidence: true });
  expect(report.result.requirementCoverage[0]?.status).toBe('inconclusive');
});

test('repeating a true observation does not create new requirement progress', async () => {
  let proposals = 0;
  const report = await runActivityWithModel(baseUrl => {
    const model = offlineModel('activity', []);
    return { ...model, async propose(context) {
      if (++proposals === 1) return { version: '1', proposalId: 'assertionnav',
        kind: 'navigate', observationId: context.observation.observationId,
        goalId: 'g1', url: `${baseUrl}/activity`, predictedEffect: 'destination opens' };
      return { version: '1', proposalId: `same${proposals}`, kind: 'verify',
        observationId: context.observation.observationId, goalId: 'g1',
        predicate: { kind: 'url', equals: `${baseUrl}/activity` } };
    } };
  }, true);
  expect(report.stopReason).toBe('REPEATED_INEFFECTIVE_VERIFICATION');
  expect(report.diagnostics?.verifications.map(item => item.newEvidence)).toEqual([true, false, false]);
  expect(report.diagnostics?.verifications.map(item => item.reason))
    .toEqual(['advanced', 'action_evidence_missing', 'action_evidence_missing']);
});
