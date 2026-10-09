import { test, expect } from '@playwright/test';
import { authoredDigest, type AgentProposalV1, type RequirementLedgerV1,
  type TaskEnvelopeV1 } from '../app/adaptive/contracts.js';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { runAdaptiveVerticalSlice } from '../app/adaptive/vertical-slice.js';
import type { ReasoningContextV1, ReasoningModel } from '../app/adaptive/interfaces.js';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { startAdaptiveFixture } from './support/adaptive-fixture.js';
import { OpenAIAdaptiveReasoningModel } from '../app/adaptive/openai-reasoning.js';
import type { AdaptiveFixture } from './support/adaptive-fixture.js';

const instruction = 'Open my account settings, enable email notifications, and verify that email notifications are enabled.';
type GoalRuleV1 = { goalId: string; kind: 'required_action' | 'outcome' | 'assertion' | 'constraint';
  operation?: 'navigate' | 'click' | 'check' | 'uncheck'; target?: { role: string; name: string };
  expectedChecked?: boolean; expectedUrl?: string };
type ProposalModel = Pick<ReasoningModel, 'propose'> & Partial<Pick<ReasoningModel, 'interpretRequirements'>>;
function setup(baseUrl: string): { task: TaskEnvelopeV1; ledger: RequirementLedgerV1; rules: GoalRuleV1[] } {
  const task: TaskEnvelopeV1 = { version: '1', taskId: 'local_fixture',
    authoredInstruction: instruction, authoredDigest: authoredDigest(instruction),
    startUrl: `${baseUrl}/`, approvalRef: 'local_fixture_approved', stateResetRef: 'fixture_reset',
    operatorConstraints: { allowedOrigins: [baseUrl], prohibitedEffects: [],
      confirmationRequiredEffects: [], allowedOperations: ['click', 'check', 'uncheck'],
      budgets: { maxActions: 8, maxObservations: 12, maxScreenshots: 2 } } };
  const phrases = ['Open my account settings', 'enable email notifications',
    'verify that email notifications are enabled'];
  const kinds = ['required_action', 'outcome', 'assertion'] as const;
  const ledger: RequirementLedgerV1 = { version: '1', taskId: task.taskId,
    authoredDigest: task.authoredDigest, authoredGoals: phrases.map((phrase, index) => ({
      goalId: `g${index}`, kind: kinds[index]!, requirement: phrase,
      sourceSpan: { start: instruction.indexOf(phrase), end: instruction.indexOf(phrase) + phrase.length },
      interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] })),
    inferredPrerequisites: [], unresolvedQuestions: [] };
  const rules: GoalRuleV1[] = [
    { goalId: 'g0', kind: 'required_action', operation: 'click', expectedUrl: `${baseUrl}/settings` },
    { goalId: 'g1', kind: 'outcome', target: { role: 'checkbox', name: 'Email notifications' }, expectedChecked: true },
    { goalId: 'g2', kind: 'assertion', target: { role: 'checkbox', name: 'Email notifications' }, expectedChecked: true },
  ];
  return { task, ledger, rules };
}

/** Legacy regression model intake is test-owned; no fixture oracle enters production options. */
function withTestIntake(model: ProposalModel, task: TaskEnvelopeV1,
  ledger: RequirementLedgerV1, rules: readonly GoalRuleV1[]): ReasoningModel {
  if (model.interpretRequirements) return model as ReasoningModel;
  return { propose: context => model.propose(context),
    interpretRequirements: async context => ({ ledger: structuredClone(ledger),
      acceptancePlan: { version: '1', taskId: task.taskId, authoredDigest: task.authoredDigest,
        sourceObservationId: context.observation.observationId,
        goals: ledger.authoredGoals.map(goal => {
          const rule = rules.find(item => item.goalId === goal.goalId)!;
          return { goalId: goal.goalId, kind: goal.kind, sourceSpan: goal.sourceSpan,
            requirement: goal.requirement, status: 'hypothesis' as const,
            predicates: rule.expectedUrl
              ? [{ kind: 'url' as const, comparison: 'path_equals' as const,
                value: new URL(rule.expectedUrl).pathname }]
              : rule.target && rule.expectedChecked !== undefined
                ? [{ kind: 'element' as const, role: rule.target.role, name: rule.target.name,
                  property: 'checked' as const, equals: rule.expectedChecked }]
                : [],
            ...(rule.kind === 'required_action' ? { action: { operation: rule.operation ?? 'click',
              afterGoalIds: [] } } : {}) };
        }) } } ) };
}

test('Responses JSON mode carries its format instruction in input and validates output', async () => {
  const secret = 'test-secret-never-log';
  const { task, ledger } = setup('http://127.0.0.1:43210');
  const observation: ReasoningContextV1['observation'] = {
    version: '1', observationId: 'obs1', sessionId: 'session1', pageId: 'page1',
    documentRevision: 'rev1', coordinateFrameId: 'frame1', url: task.startUrl,
    observedAt: new Date().toISOString(), viewport: { width: 1280, height: 720, scale: 1 },
    accessibility: { snapshotRef: 'snapshot1', summary: '- link "Account settings"' },
    dom: { factsRef: 'facts1', summary: 'Account settings link',
      elements: [{ ref: 'e1', role: 'link', name: 'Account settings', enabled: true }] },
  };
  const context: ReasoningContextV1 = { original: { taskId: task.taskId,
    authoredInstruction: task.authoredInstruction, authoredDigest: task.authoredDigest,
    startUrl: task.startUrl }, ledger, observation, validatedHistory: [],
    unresolvedGoalIds: ['g0', 'g1', 'g2'], availableOperations: ['click', 'check', 'observe', 'verify'],
    remainingBudgets: { modelTurns: 8, browserActions: 8, elapsedMs: 30_000 },
    maxContextCharacters: 20_000 };
  const valid: AgentProposalV1 = { version: '1', proposalId: 'p1', kind: 'interact',
    observationId: observation.observationId, goalId: 'g0', operation: 'click',
    target: { kind: 'element_ref', ref: 'e1' }, predictedEffect: 'Settings opens' };
  const outputs = [JSON.stringify(valid), '{invalid json', JSON.stringify({ kind: 'interact' })];
  const requests: Record<string, unknown>[] = [];
  const logged: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const outputText = outputs.shift();
    if (outputText === undefined) throw new Error('UNEXPECTED_PROVIDER_CALL');
    return new Response(JSON.stringify({ id: 'mock_response', object: 'response',
      status: 'completed', model: 'mock-model', output: [{ id: 'mock_message', type: 'message',
        role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outputText,
          annotations: [] }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  console.log = (...items) => { logged.push(items.map(String).join(' ')); };
  console.error = (...items) => { logged.push(items.map(String).join(' ')); };
  console.warn = (...items) => { logged.push(items.map(String).join(' ')); };
  try {
    const adapter = new OpenAIAdaptiveReasoningModel(secret, 'mock-model');
    expect(await adapter.propose(context)).toEqual(valid);
    await expect(adapter.propose(context)).rejects.toThrow();
    await expect(adapter.propose(context)).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog; console.error = originalError; console.warn = originalWarn;
  }
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request.text).toEqual({ format: { type: 'json_object' } });
    expect(request.store).toBe(false);
    expect(request.input).toContain('JSON object');
    const submitted = JSON.parse(String(request.input).split('\n').slice(1).join('\n'));
    expect(submitted.instruction).toBe(task.authoredInstruction);
    expect(submitted.authoredGoals).toEqual(ledger.authoredGoals.map(goal => ({
      goalId: goal.goalId, kind: goal.kind, requirement: goal.requirement })));
    expect(submitted.observation).toEqual(observation);
    expect(submitted.availableOperations).toEqual(context.availableOperations);
  }
  expect(logged).toEqual([]);
  expect(JSON.stringify(requests)).not.toContain(secret);
});

class ObservingModel implements ProposalModel {
  readonly seen: ReasoningContextV1[] = [];
  async propose(context: ReasoningContextV1): Promise<AgentProposalV1> {
    this.seen.push(context);
    const observation = context.observation;
    const element = observation.dom.elements;
    const make = (operation: 'click' | 'check', ref: string, goalId: string): AgentProposalV1 => {
      const fact = element.find(item => item.ref === ref)!;
      return { version: '1', kind: 'interact', proposalId: `proposal${this.seen.length}`,
        observationId: observation.observationId, goalId, operation,
        target: { kind: 'role_name', role: fact.role!, name: fact.name! },
        predictedEffect: 'Relevant page state changes' };
    };
    if (observation.url.endsWith('/')) {
      const settings = element.find(item => item.role === 'link' && /Settings|settings/.test(item.name ?? ''));
      if (settings) return make('click', settings.ref, 'g0');
      const profile = element.find(item => item.name === 'Profile');
      if (profile) return make('click', profile.ref, 'g0');
    }
    const checkbox = element.find(item => item.role === 'checkbox' && item.name === 'Email notifications');
    if (checkbox && !checkbox.checked) return make('check', checkbox.ref, 'g1');
    const verifyGoal = context.unresolvedGoalIds.find(goalId => goalId === 'g1' || goalId === 'g2');
    if (checkbox && verifyGoal) return { version: '1', kind: 'verify',
      proposalId: `proposal${this.seen.length}`, observationId: observation.observationId,
      goalId: verifyGoal, predicate: { kind: 'element_state',
        target: { kind: 'role_name', role: 'checkbox', name: 'Email notifications' },
        property: 'checked', equals: true } };
    return { version: '1', kind: 'finish_exploration', proposalId: `proposal${this.seen.length}`,
      unresolvedGoalIds: [...context.unresolvedGoalIds] };
  }
}

for (const variant of ['a', 'b'] as const) test(`adaptive local fixture ${variant} discovers and cleanly executes`, async () => {
  let browsers = 0;
  const fixture = await startAdaptiveFixture(variant, () => browsers);
  const { task, ledger, rules } = setup(fixture.baseUrl);
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_local', version: '1', browser: 'chromium',
    viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} }, profileSchemaVersion: '5',
    presentationMode: 'headless', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows' }]);
  const factory = new ProtectedContextFactory(catalog);
  const model = new ObservingModel();
  try {
    const report = await runAdaptiveVerticalSlice({ task, model: withTestIntake(model, task, ledger, rules),
      reset: fixture.reset,
      openBrowser: async () => { browsers++; const session = await factory.open({ id: 'adaptive_local', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close()); },
      maxModelTurns: 8, maxElapsedMs: 30_000, maxIneffectiveActions: 2 });
    if (report.result.outcome !== 'VERIFIED_PASS') console.log(JSON.stringify({ variant, result: report.result,
      proposals: report.trace.proposals, actions: report.trace.actions, observations: report.observations }));
    expect(report.result.outcome).toBe('VERIFIED_PASS');
    expect(report.timingsMs.total).toBeGreaterThanOrEqual(0);
    expect(report.timingsMs.exploration + report.timingsMs.cleanReset +
      report.timingsMs.cleanExecution + report.timingsMs.verificationCleanup)
      .toBeCloseTo(report.timingsMs.total, 3);
    expect(report.finalCleanState?.url).toBe(`${fixture.baseUrl}/settings`);
    expect(report.finalCleanState?.controls).toContainEqual({ role: 'checkbox',
      name: 'Email notifications', checked: true });
    expect(report.procedure?.steps.length).toBe(variant === 'a' ? 2 : 3);
    expect(model.seen).toHaveLength(variant === 'a' ? 4 : 5);
    expect(report.trace.proposals.some(proposal => proposal.kind === 'finish_exploration')).toBe(false);
    expect(report.explorationChecks.map(check => [check.goalId, check.satisfied, check.newInformation]))
      .toEqual([['g1', true, true], ['g2', true, true]]);
    expect(report.procedure?.steps.every(step => !step.expectedTransition.startsWith('Browser state changed'))).toBe(true);
    expect(report.result.cleanStart.applicationStateVerified).toBe(true);
    expect(report.result.cleanStart.freshBrowserContext).toBe(true);
    expect(await fixture.state()).toBe(true);
    expect(model.seen[0]?.observation.url).toBe(task.startUrl);
    expect(model.seen.some(item => item.observation.url.endsWith('/settings'))).toBe(true);
    expect(model.seen.some(item => item.validatedHistory.some(entry => !!entry.action))).toBe(true);
    for (const seen of model.seen) for (const entry of seen.validatedHistory)
      if (entry.action) expect(entry.action.afterObservationId).toBe(entry.observation.observationId);
    const first = report.trace.proposals[0];
    expect(first?.kind).toBe('interact');
    if (first?.kind === 'interact') expect(first.target).toEqual(variant === 'a'
      ? { kind: 'role_name', role: 'link', name: 'Account settings' }
      : { kind: 'role_name', role: 'button', name: 'Profile' });
    if (variant === 'b') {
      expect(report.explorationActions[0]?.observedEffect).toContain('"Settings" appeared');
      expect(model.seen.some(item => item.observation.dom.elements.some(
        element => element.name === 'Settings'))).toBe(true);
      const second = report.trace.proposals[1];
      if (second?.kind === 'interact') expect(second.target).toEqual(
        { kind: 'role_name', role: 'link', name: 'Settings' });
    }
  } finally { await fixture.close(); }
});

async function exercise(variant: 'a' | 'b' | 'c', model: ProposalModel,
  options: { maxActions?: number; maxTurns?: number; maxElapsedMs?: number;
    onCleanReset?: (fixture: AdaptiveFixture) => void;
    failReset?: boolean; failOpen?: boolean; failCleanup?: boolean; navigationRule?: boolean;
    failExploreAction?: boolean; failCleanAction?: boolean; requiredActionMismatch?: boolean;
    assertionUnobservable?: boolean } = {}) {
  let browsers = 0, resets = 0;
  const fixture = await startAdaptiveFixture(variant, () => browsers);
  const { task, ledger, rules } = setup(fixture.baseUrl);
  if (options.navigationRule) rules[0]!.operation = 'navigate';
  if (options.requiredActionMismatch) rules[0]!.operation = 'uncheck';
  if (options.assertionUnobservable) rules[2]!.target = { role: 'checkbox', name: 'Unavailable assertion' };
  if (options.maxActions) task.operatorConstraints.budgets.maxActions = options.maxActions;
  if (options.failReset) fixture.setFailReset(true);
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_local', version: '1', browser: 'chromium',
    viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} }, profileSchemaVersion: '5',
    presentationMode: 'headless', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows' }]);
  const factory = new ProtectedContextFactory(catalog);
  try {
    return await runAdaptiveVerticalSlice({ task, model: withTestIntake(model, task, ledger, rules),
      reset: { prepareCleanState: async currentTask => {
        resets++;
        if (resets === 2) options.onCleanReset?.(fixture);
        return fixture.reset.prepareCleanState(currentTask);
      } },
      openBrowser: async () => {
        if (options.failOpen) throw new Error('BROWSER_LAUNCH_FAILED');
        browsers++;
        const session = await factory.open({ id: 'adaptive_local', version: '1' });
        const browser = new AdaptiveBrowser(await session.context.newPage(), async () => {
          await session.close();
          if (options.failCleanup) throw new Error('CLEANUP_FAILED');
        });
        if (browsers === 1 && options.failExploreAction || browsers === 2 && options.failCleanAction)
          browser.dispatch = async () => { throw new Error('BROWSER_ACTION_THROWN'); };
        return browser;
      }, maxModelTurns: options.maxTurns ?? 8,
      maxElapsedMs: options.maxElapsedMs ?? 30_000, maxIneffectiveActions: 2 });
  } finally { await fixture.close(); }
}

const proposalModel = (make: (context: ReasoningContextV1) => unknown): ProposalModel => ({
  propose: async context => make(context) as AgentProposalV1 });
const click = (context: ReasoningContextV1, ref = 'e0'): AgentProposalV1 => ({ version: '1',
  proposalId: 'proposal', kind: 'interact', operation: 'click', goalId: 'g0',
  observationId: context.observation.observationId, target: { kind: 'element_ref', ref },
  predictedEffect: 'Navigation appears' });

test('invalid, absent, stale, unauthorized, and unsupported model proposals stop before dispatch', async () => {
  const cases: Array<[string, ProposalModel, string]> = [
    ['malformed', proposalModel(() => ({ kind: 'interact', script: 'alert(1)' })), 'BLOCKED'],
    ['absent', proposalModel(context => click(context, 'e999')), 'BLOCKED'],
    ['stale', proposalModel(context => ({ ...click(context), observationId: 'stale' })), 'BLOCKED'],
    ['navigation', proposalModel(context => ({ version: '1', proposalId: 'p', kind: 'navigate',
      observationId: context.observation.observationId, url: 'https://example.org/',
      predictedEffect: 'leave scope' })), 'BLOCKED'],
    ['unsupported', proposalModel(context => ({ ...click(context), operation: 'fill', value: 'x' })), 'BLOCKED'],
  ];
  for (const [name, model, expected] of cases) {
    const report = await exercise('a', model);
    expect(report.result.outcome, name).toBe(expected);
    expect(report.trace.actions, name).toHaveLength(0);
  }
});

test('budgets, ineffective actions, browser and reset failure retain closed outcomes', async () => {
  expect((await exercise('b', new ObservingModel(), { maxActions: 1 })).result.outcome).toBe('BLOCKED');
  const repeat = proposalModel(context => click(context));
  const repeated = await exercise('b', repeat);
  expect(repeated.result.outcome).toBe('BLOCKED');
  expect(repeated.stopReason).toBe('REPEATED_INEFFECTIVE_ACTION');
  expect((await exercise('a', new ObservingModel(), { failOpen: true })).result.outcome).toBe('ENVIRONMENT_FAILED');
  expect((await exercise('a', new ObservingModel(), { failReset: true })).result.outcome).toBe('BLOCKED');
  expect((await exercise('a', new ObservingModel(), { maxTurns: 1 })).result.outcome).toBe('BLOCKED');
});

test('model self-report cannot finish unresolved goals or invent a procedure', async () => {
  const model = proposalModel(context => ({ version: '1', proposalId: 'p', kind: 'finish_exploration',
    unresolvedGoalIds: [...context.unresolvedGoalIds] }));
  const report = await exercise('a', model);
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.procedure).toBeUndefined();
});

test('evidence-complete exploration hands off without an additional model turn', async () => {
  const a = await exercise('a', new ObservingModel(), { maxTurns: 4 });
  const b = await exercise('b', new ObservingModel(), { maxTurns: 5 });
  for (const report of [a, b]) {
    expect(report.result.outcome).toBe('VERIFIED_PASS');
    expect(report.procedure?.discoveryConfidence).toBe('demonstrated');
    expect(report.result.cleanStart.applicationStateVerified).toBe(true);
    expect(report.result.requirementCoverage.every(item => item.status === 'verified_true')).toBe(true);
  }
});

test('final state alone cannot complete a missing authored action', async () => {
  const model = proposalModel(context => {
    const observation = context.observation;
    if (observation.url.endsWith('/')) return { version: '1', proposalId: 'nav', kind: 'navigate',
      observationId: observation.observationId, goalId: 'g1',
      url: new URL('/settings', observation.url).href, predictedEffect: 'Settings page opens' };
    const checkbox = observation.dom.elements.find(item => item.role === 'checkbox');
    if (checkbox && !checkbox.checked) return { version: '1', proposalId: 'check', kind: 'interact',
      observationId: observation.observationId, goalId: 'g1', operation: 'check',
      target: { kind: 'element_ref', ref: checkbox.ref }, predictedEffect: 'Notifications enabled' };
    const goalId = context.unresolvedGoalIds.find(item => item === 'g1' || item === 'g2');
    if (goalId) return { version: '1', proposalId: `verify${goalId}`, kind: 'verify',
      observationId: observation.observationId, goalId,
      predicate: { kind: 'element_state', target: { kind: 'element_ref', ref: checkbox!.ref },
        property: 'checked', equals: true } };
    return { version: '1', proposalId: 'finish', kind: 'finish_exploration', unresolvedGoalIds: [] };
  });
  const report = await exercise('a', model);
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.procedure).toBeUndefined();
  expect(report.trace.unresolvedGoalIds).toContain('g0');
  expect(report.explorationChecks.map(check => check.satisfied)).toEqual([true, true]);
});

test('false and repeated verification observations stop without inventing completion', async () => {
  const model = proposalModel(context => {
    const observation = context.observation;
    if (observation.url.endsWith('/')) return click(context);
    const checkbox = observation.dom.elements.find(item => item.role === 'checkbox')!;
    return { version: '1', proposalId: `verify${observation.observationId}`, kind: 'verify',
      observationId: observation.observationId, goalId: 'g1',
      predicate: { kind: 'element_state', target: { kind: 'element_ref', ref: checkbox.ref },
        property: 'checked', equals: true } };
  });
  const report = await exercise('a', model);
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.stopReason).toBe('REPEATED_INEFFECTIVE_VERIFICATION');
  expect(report.procedure).toBeUndefined();
  expect(report.explorationChecks.map(check => [check.satisfied, check.newInformation]))
    .toEqual([[false, true], [false, false], [false, false]]);
  expect(report.trace.unresolvedGoalIds).toContain('g1');
});

test('model context mutation cannot rewrite authored obligations or live browser evidence', async () => {
  const model = proposalModel(context => {
    (context.ledger.authoredGoals as RequirementLedgerV1['authoredGoals']).splice(0);
    (context.observation as { url: string }).url = 'https://untrusted.example/';
    return { version: '1', proposalId: 'p', kind: 'finish_exploration',
      unresolvedGoalIds: [...context.unresolvedGoalIds] };
  });
  const report = await exercise('a', model);
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.result.requirementCoverage).toHaveLength(3);
  expect(report.trace.unresolvedGoalIds).toHaveLength(3);
  expect(report.observations[0]?.url).toContain('127.0.0.1');
});

test('clean target drift, false persisted state, and cleanup failure cannot pass', async () => {
  const drift = await exercise('a', new ObservingModel(), { onCleanReset: fixture => fixture.setDrift(true) });
  expect(drift.result.outcome).toBe('BLOCKED');
  const transition = await exercise('a', new ObservingModel(), {
    onCleanReset: fixture => fixture.setDestinationDrift(true) });
  expect(transition.result.outcome).toBe('BLOCKED');
  expect(transition.stopReason).toBe('CLEAN_TRANSITION_MISMATCH');
  const falseState = await exercise('a', new ObservingModel(), {
    onCleanReset: fixture => fixture.setClearOnReload(true) });
  expect(falseState.result.outcome).toBe('VERIFIED_FAIL');
  expect(falseState.result.requirementCoverage.some(item => item.status === 'verified_false')).toBe(true);
  const missingAction = await exercise('a', new ObservingModel(), { requiredActionMismatch: true });
  expect(missingAction.result.outcome).toBe('BLOCKED');
  expect(missingAction.procedure).toBeUndefined();
  expect(missingAction.trace.unresolvedGoalIds).toContain('g0');
  const unobservable = await exercise('a', new ObservingModel(), { assertionUnobservable: true });
  expect(unobservable.result.outcome).toBe('BLOCKED');
  expect(unobservable.trace.unresolvedGoalIds).toContain('g2');
  const cleanup = await exercise('a', new ObservingModel(), { failCleanup: true });
  expect(cleanup.result.outcome).toBe('ENVIRONMENT_FAILED');
  expect(cleanup.result.cleanupVerified).toBe(false);
});

test('browser action exceptions retain failed delivery evidence in exploration and clean pass', async () => {
  const exploration = await exercise('a', new ObservingModel(), { failExploreAction: true });
  expect(exploration.result.outcome).toBe('ENVIRONMENT_FAILED');
  expect(exploration.trace.actions).toHaveLength(1);
  expect(exploration.trace.actions[0]?.delivery).toBe('unknown');
  expect(exploration.trace.actions[0]?.stopReason).toBe('BROWSER_ACTION_ERROR');
  const clean = await exercise('a', new ObservingModel(), { failCleanAction: true });
  expect(clean.result.outcome).toBe('ENVIRONMENT_FAILED');
  expect(clean.result.actionEvidenceIds).toHaveLength(1);
});

test('trusted reset distinguishes application reset from a fresh context', async () => {
  const fixture = await startAdaptiveFixture('a', () => 0);
  try {
    const { task } = setup(fixture.baseUrl);
    expect((await fixture.reset.prepareCleanState(task)).applicationStateVerified).toBe(true);
    expect((await fixture.reset.prepareCleanState(task)).freshBrowserContext).toBe(false);
  } finally { await fixture.close(); }
});

test('observation broker invalidates identical-looking document reloads', async () => {
  const fixture = await startAdaptiveFixture('a', () => 1);
  const { task } = setup(fixture.baseUrl);
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_local', version: '1', browser: 'chromium',
    viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} }, profileSchemaVersion: '5',
    presentationMode: 'headless', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows' }]);
  const session = await new ProtectedContextFactory(catalog).open({ id: 'adaptive_local', version: '1' });
  try {
    const broker = new AdaptiveBrowser(await session.context.newPage(), () => session.close());
    const initial = await broker.observeInitial(task);
    await broker.page.reload();
    await expect(broker.assertCurrent(initial)).rejects.toThrow('STALE_LIVE_PAGE');
    const reloaded = await broker.observeCurrent();
    expect(reloaded.documentRevision).not.toBe(initial.documentRevision);
  } finally { await session.close(); await fixture.close(); }
});

test('same-URL click reload yields fresh observations and never reuses or repeats an old click', async () => {
  const fixture = await startAdaptiveFixture('a', () => 1);
  const { task } = setup(fixture.baseUrl);
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_local', version: '1', browser: 'chromium',
    viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} }, profileSchemaVersion: '5',
    presentationMode: 'headless', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows' }]);
  const session = await new ProtectedContextFactory(catalog).open({ id: 'adaptive_local', version: '1' });
  try {
    const page = await session.context.newPage();
    let documents = 0;
    await page.route(`${fixture.baseUrl}/reload`, async route => {
      documents++;
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reload</title>' +
        '<button onclick="location.href=location.href">Reload</button>' });
    });
    const broker = new AdaptiveBrowser(page, () => session.close());
    const initial = await broker.observeInitial({ ...task, startUrl: `${fixture.baseUrl}/reload` });
    const click = (observationId: string) => ({ version: '1' as const, proposalId: 'reload',
      kind: 'interact' as const, observationId, goalId: 'reload', operation: 'click' as const,
      target: { kind: 'role_name' as const, role: 'button', name: 'Reload' },
      predictedEffect: 'Reload the current document' });
    await broker.dispatch(click(initial.observationId), initial);
    const afterFirstClick = await broker.observeCurrent();
    expect(afterFirstClick.url).toBe(initial.url);
    expect(afterFirstClick.documentRevision).not.toBe(initial.documentRevision);
    expect(documents).toBe(2);
    await expect(broker.dispatch(click(initial.observationId), initial)).rejects.toThrow('STALE_LIVE_PAGE');
    expect(documents).toBe(2);
    await broker.dispatch(click(afterFirstClick.observationId), afterFirstClick);
    const screenshot = await broker.captureScreenshot(afterFirstClick.observationId);
    expect(screenshot.url).toBe(initial.url);
    expect(screenshot.documentRevision).not.toBe(afterFirstClick.documentRevision);
    expect(screenshot.observationId).not.toBe(afterFirstClick.observationId);
    expect(screenshot.screenshot?.coordinateFrameId).toBe(screenshot.observationId);
    expect(documents).toBe(3);
    await broker.assertCurrent(screenshot);
  } finally { await session.close(); await fixture.close(); }
});

test('demonstrated direct navigation becomes a clean procedure step', async () => {
  const model = proposalModel(context => {
    const observation = context.observation;
    if (observation.url.endsWith('/')) return { version: '1', proposalId: 'nav', kind: 'navigate',
      observationId: observation.observationId, goalId: 'g0',
      url: new URL('/settings', observation.url).href, predictedEffect: 'Settings page opens' };
    const checkbox = observation.dom.elements.find(item => item.role === 'checkbox');
    if (checkbox && !checkbox.checked) return { version: '1', proposalId: 'check', kind: 'interact',
      observationId: observation.observationId, goalId: 'g1', operation: 'check',
      target: { kind: 'element_ref', ref: checkbox.ref }, predictedEffect: 'Notifications enabled' };
    const verifyGoal = context.unresolvedGoalIds.find(goalId => goalId === 'g1' || goalId === 'g2');
    if (checkbox && verifyGoal) return { version: '1', proposalId: `verify${verifyGoal}`,
      kind: 'verify', observationId: observation.observationId, goalId: verifyGoal,
      predicate: { kind: 'element_state', target: { kind: 'role_name', role: 'checkbox',
        name: 'Email notifications' }, property: 'checked', equals: true } };
    return { version: '1', proposalId: 'finish', kind: 'finish_exploration', unresolvedGoalIds: [] };
  });
  const report = await exercise('a', model, { navigationRule: true });
  expect(report.result.outcome).toBe('VERIFIED_PASS');
  expect(report.procedure?.steps[0]?.operation).toBe('navigate');
});

test('unlabeled gear uses screenshot discovery and fresh clean visual re-identification', async () => {
  const seen: Array<{ clean: boolean; ref?: string; image?: string }> = [];
  let visualClicks = 0;
  const model: ProposalModel = { async propose(context) {
    const observation = context.observation;
    seen.push({ clean: !!context.cleanVisualTarget,
      ...(observation.screenshot ? { ref: observation.screenshot.ref } : {}),
      ...(context.screenshotDataUrl ? { image: context.screenshotDataUrl } : {}) });
    if (context.cleanVisualTarget) {
      visualClicks++;
      return { version: '1', proposalId: 'cleanGear', kind: 'interact', operation: 'click',
        goalId: context.cleanVisualTarget.goalId, observationId: observation.observationId,
        target: { kind: 'visual_coordinate', screenshotRef: observation.screenshot!.ref,
          coordinateFrameId: observation.coordinateFrameId, viewport: observation.viewport,
          x: 1227, y: 36, description: context.cleanVisualTarget.description,
          context: context.cleanVisualTarget.context }, predictedEffect: context.cleanVisualTarget.expectedTransition };
    }
    if (observation.url.endsWith('/') && !observation.screenshot) return { version: '1',
      proposalId: 'inspectGear', kind: 'observe', observationId: observation.observationId,
      goalId: 'g0', scope: 'page', modality: 'screenshot' };
    if (observation.url.endsWith('/')) return { version: '1', proposalId: 'clickGear',
      kind: 'interact', observationId: observation.observationId, goalId: 'g0', operation: 'click',
      target: { kind: 'visual_coordinate', screenshotRef: observation.screenshot!.ref,
        coordinateFrameId: observation.coordinateFrameId, viewport: observation.viewport,
        x: 1162, y: 36, description: 'gear icon', context: 'right side of account header' },
      predictedEffect: 'Account settings opens' };
    const checkbox = observation.dom.elements.find(item => item.role === 'checkbox');
    if (checkbox && !checkbox.checked) return { version: '1', proposalId: 'enableEmail',
      kind: 'interact', observationId: observation.observationId, goalId: 'g1', operation: 'check',
      target: { kind: 'role_name', role: 'checkbox', name: 'Email notifications' },
      predictedEffect: 'Email notifications enabled' };
    const goalId = context.unresolvedGoalIds.find(item => item === 'g1' || item === 'g2');
    return { version: '1', proposalId: `verify${goalId}`, kind: 'verify',
      observationId: observation.observationId, goalId: goalId!,
      predicate: { kind: 'element_state', target: { kind: 'role_name', role: 'checkbox',
        name: 'Email notifications' }, property: 'checked', equals: true } };
  } };
  const report = await exercise('c', model);
  expect(report.result.outcome, report.stopReason).toBe('VERIFIED_PASS');
  expect(report.procedure?.steps[0]?.targetStrategies[0]?.target).toMatchObject({
    kind: 'visual_anchor', description: 'gear icon', context: 'right side of account header' });
  expect(report.cleanVisualModelCalls).toBe(1);
  expect(report.trace.proposals).toHaveLength(5);
  expect(seen).toHaveLength(6);
  expect(report.explorationActions).toHaveLength(2);
  expect(report.result.actionEvidenceIds).toHaveLength(2);
  const explorationVisual = report.trace.proposals.find(item => item.kind === 'interact' &&
    item.target.kind === 'visual_coordinate');
  expect(explorationVisual?.kind === 'interact' && explorationVisual.target.kind === 'visual_coordinate'
    ? explorationVisual.target.x : undefined).toBe(1162);
  expect(report.cleanVisualReidentifications[0]?.x).toBe(1227);
  expect(report.cleanVisualReidentifications[0]?.x).not.toBe(1162);
  expect(visualClicks).toBe(1);
  expect(seen.some(item => !!item.image?.startsWith('data:image/jpeg;base64,'))).toBe(true);
  expect(seen.find(item => item.clean)?.ref).not.toBe(seen.find(item => !item.clean && item.ref)?.ref);
  expect(report.explorationActions[0]?.observedEffect).toContain('/settings');
  expect(report.result.requirementCoverage.every(item => item.status === 'verified_true')).toBe(true);
});

type CrossModalSeen = { clean: boolean; image: boolean; sessionId: string;
  observationId: string; screenshotRef: string | undefined;
  ref: string | undefined; x: number | undefined };
function crossModalModel(seen: CrossModalSeen[], cleanTarget: 'coordinate' | 'element_ref' = 'coordinate'):
  ProposalModel {
  return { async propose(context) {
    const observation = context.observation;
    const unnamed = observation.dom.elements.filter(item => item.role === 'button' && !item.name);
    seen.push({ clean: !!context.cleanVisualTarget, image: !!context.screenshotDataUrl,
      sessionId: observation.sessionId, observationId: observation.observationId,
      screenshotRef: observation.screenshot?.ref, ref: unnamed[0]?.ref,
      x: unnamed[0]?.bounds?.x });
    if (context.cleanVisualTarget) {
      const bound = unnamed[0]?.bounds;
      if (!bound) throw new Error('CLEAN_CONTROL_BOUNDS_MISSING');
      if (cleanTarget === 'element_ref') return { version: '1', proposalId: 'freshGearRef',
        kind: 'interact', operation: 'click', observationId: observation.observationId,
        goalId: context.cleanVisualTarget.goalId,
        target: { kind: 'element_ref', ref: unnamed[0]!.ref },
        predictedEffect: context.cleanVisualTarget.expectedTransition };
      return { version: '1', proposalId: 'freshGear', kind: 'interact', operation: 'click',
        observationId: observation.observationId, goalId: context.cleanVisualTarget.goalId,
        target: { kind: 'visual_coordinate', screenshotRef: observation.screenshot!.ref,
          coordinateFrameId: observation.coordinateFrameId, viewport: observation.viewport,
          x: bound.x + bound.width / 2, y: bound.y + bound.height / 2,
          description: context.cleanVisualTarget.description, context: context.cleanVisualTarget.context },
        predictedEffect: context.cleanVisualTarget.expectedTransition };
    }
    if (observation.url.endsWith('/') && !observation.screenshot) return { version: '1',
      proposalId: 'inspectUnnamed', kind: 'observe', observationId: observation.observationId,
      goalId: 'g0', scope: 'page', modality: 'screenshot' };
    if (observation.url.endsWith('/')) {
      if (unnamed.length !== 1 || !unnamed[0]?.bounds || !context.screenshotDataUrl)
        throw new Error('UNNAMED_VISUAL_BINDING_MISSING');
      return { version: '1', proposalId: 'clickBoundRef', kind: 'interact',
        observationId: observation.observationId, goalId: 'g0', operation: 'click',
        target: { kind: 'element_ref', ref: unnamed[0].ref },
        predictedEffect: 'Account settings opens' };
    }
    const checkbox = observation.dom.elements.find(item => item.role === 'checkbox' &&
      item.name === 'Email notifications');
    if (checkbox && !checkbox.checked) return { version: '1', proposalId: 'enableEmail',
      kind: 'interact', observationId: observation.observationId, goalId: 'g1', operation: 'check',
      target: { kind: 'role_name', role: 'checkbox', name: 'Email notifications' },
      predictedEffect: 'Email notifications enabled' };
    const goalId = context.unresolvedGoalIds.find(item => item === 'g1' || item === 'g2');
    return { version: '1', proposalId: `verify${goalId}`, kind: 'verify',
      observationId: observation.observationId, goalId: goalId!,
      predicate: { kind: 'element_state', target: { kind: 'role_name', role: 'checkbox',
        name: 'Email notifications' }, property: 'checked', equals: true } };
  } };
}

test('screenshot-bound unnamed element ref becomes a visual procedure with fresh clean grounding', async () => {
  const seen: CrossModalSeen[] = [];
  const model = crossModalModel(seen);
  const report = await exercise('c', model);
  expect(report.result.outcome, report.stopReason).toBe('VERIFIED_PASS');
  expect(report.timingsMs.total).toBeGreaterThanOrEqual(0);
  expect(report.finalCleanState?.url.endsWith('/settings')).toBe(true);
  expect(report.finalCleanState?.controls).toContainEqual({ role: 'checkbox',
    name: 'Email notifications', checked: true });
  const first = report.trace.proposals.find(item => item.kind === 'interact');
  expect(first?.kind === 'interact' ? first.target.kind : undefined).toBe('element_ref');
  expect(report.explorationActions[0]?.observedEffect).toContain('/settings');
  const anchor = report.procedure?.steps[0]?.targetStrategies[0]?.target;
  expect(anchor?.kind).toBe('visual_anchor');
  expect(JSON.stringify(anchor)).not.toContain('e0');
  expect(anchor?.kind === 'visual_anchor' ? anchor.visualKind : undefined).toBe('svg_icon');
  expect(report.cleanVisualModelCalls).toBe(1);
  expect(report.cleanVisualReidentifications).toHaveLength(1);
  const explore = seen.find(item => !item.clean && item.image && item.ref);
  const clean = seen.find(item => item.clean);
  expect(explore?.screenshotRef).toBeTruthy();
  expect(clean?.screenshotRef).toBeTruthy();
  expect(clean?.screenshotRef).not.toBe(explore?.screenshotRef);
  expect(clean?.x).not.toBe(explore?.x);
  expect(report.result.cleanStart).toMatchObject({ freshBrowserContext: true,
    applicationStateVerified: true });
  expect(report.result.requirementCoverage.every(item => item.status === 'verified_true')).toBe(true);
  expect(report.result.cleanupVerified).toBe(true);
});

test('clean pass re-identifies the visual anchor through a fresh unnamed element ref', async () => {
  const seen: CrossModalSeen[] = [];
  const report = await exercise('c', crossModalModel(seen, 'element_ref'));
  expect(report.result.outcome, report.stopReason).toBe('VERIFIED_PASS');
  const exploration = seen.find(item => !item.clean && item.image && item.ref);
  const clean = seen.find(item => item.clean);
  expect(exploration?.ref).toBe('e0');
  expect(clean?.ref).toBe('e0');
  expect(clean?.sessionId).not.toBe(exploration?.sessionId);
  expect(clean?.observationId).not.toBe(exploration?.observationId);
  expect(clean?.screenshotRef).not.toBe(exploration?.screenshotRef);
  expect(clean?.x).not.toBe(exploration?.x);
  expect(report.cleanVisualModelCalls).toBe(1);
  expect(report.cleanVisualReidentifications).toHaveLength(1);
  expect(report.result.requirementCoverage.every(item => item.status === 'verified_true')).toBe(true);
});

test('visually plausible clean target with wrong destination cannot verify the task', async () => {
  const report = await exercise('c', crossModalModel([]), {
    onCleanReset: fixture => fixture.setDestinationDrift(true),
  });
  expect(report.explorationActions[0]?.observedEffect).toContain('/settings');
  expect(report.cleanVisualModelCalls).toBe(1);
  expect(report.result.outcome).not.toBe('VERIFIED_PASS');
  expect(report.stopReason).toBe('CLEAN_TRANSITION_MISMATCH');
  expect(report.result.requirementCoverage.every(item => item.status !== 'verified_true')).toBe(true);
  expect(report.result.cleanupVerified).toBe(true);
});

test('opt-in live OpenAI model explores all three local fixture variants', async () => {
  test.skip(process.env.ADAPTIVE_PHASE2_LIVE_ACCEPTANCE !== '1' ||
    process.env.ADAPTIVE_LIVE_SMOKE !== '1' || !process.env.OPENAI_API_KEY ||
    !process.env.ADAPTIVE_LIVE_MODEL, 'Requires explicit local live-smoke flag, model and credentials');
  test.setTimeout(210_000);
  const adapter = new OpenAIAdaptiveReasoningModel(
    process.env.OPENAI_API_KEY!, process.env.ADAPTIVE_LIVE_MODEL!);
  const liveVariant = process.env.ADAPTIVE_LIVE_VARIANT;
  if (liveVariant && liveVariant !== 'c') throw new Error('ADAPTIVE_LIVE_VARIANT_UNSUPPORTED');
  const variants: ReadonlyArray<'a' | 'b' | 'c'> = liveVariant === 'c' ? ['c'] : ['a', 'b', 'c'];
  const results: Array<{ variant: 'a' | 'b' | 'c'; outcome: string; firstAction: {
    operation: string; target: { role: string; name: string }; page: string } | undefined;
    subsequentObservationUsed: boolean; visualDiscovery: boolean }> = [];
  for (const variant of variants) {
    const turns: Array<{ turn: number; page: string; observationId: string;
      screenshotRef?: string; imageProvided: boolean; cleanVisual: boolean;
      visibleControls: Array<{ role?: string; name?: string; checked?: boolean }>;
      remainingGoals: readonly string[]; proposal?: AgentProposalV1; modelError?: string }> = [];
    const model: ReasoningModel = { interpretRequirements: context => adapter.interpretRequirements(context),
      async propose(context) {
      const entry = { turn: turns.length + 1, page: new URL(context.observation.url).pathname,
        observationId: context.observation.observationId,
        ...(context.observation.screenshot ? { screenshotRef: context.observation.screenshot.ref } : {}),
        imageProvided: !!context.screenshotDataUrl, cleanVisual: !!context.cleanVisualTarget,
        visibleControls: context.observation.dom.elements.slice(0, 20).map(item => ({
          role: item.role, name: item.name, ...(item.checked === undefined ? {} : { checked: item.checked }) })),
        remainingGoals: [...context.unresolvedGoalIds] } as typeof turns[number];
      turns.push(entry);
      try { entry.proposal = await adapter.propose(context); return entry.proposal; }
      catch (error) { entry.modelError = error instanceof Error ? error.message : 'UNKNOWN_MODEL_ERROR'; throw error; }
    } };
    try {
      const report = await exercise(variant, model, { maxElapsedMs: 150_000 });
      const evidence = new Map(report.explorationActions.map(action => [action.proposalId, action]));
      console.log(`ADAPTIVE_LIVE_${variant.toUpperCase()}=${JSON.stringify({
        model: adapter.model, outcome: report.result.outcome, stopReason: report.stopReason,
        modelCalls: turns.length, explorationBrowserActions: report.explorationActions.length,
        cleanBrowserActions: report.result.actionEvidenceIds.length,
        cleanVisualModelCalls: report.cleanVisualModelCalls,
        cleanVisualReidentifications: report.cleanVisualReidentifications,
        timingsMs: report.timingsMs, deadlineMs: 150_000,
        finalCleanState: report.finalCleanState,
        turns: turns.map((turn, index) => ({ ...turn, gateway: turn.proposal &&
          (turn.proposal.kind === 'interact' || turn.proposal.kind === 'navigate')
          ? evidence.has(turn.proposal.proposalId) ? 'dispatched' : 'rejected_or_not_dispatched'
          : turn.proposal ? 'validated_or_terminal' : 'no_proposal',
          action: turn.proposal ? evidence.get(turn.proposal.proposalId) : undefined,
          verification: turn.proposal ? report.explorationChecks.find(
            check => check.proposalId === turn.proposal?.proposalId) : undefined,
          newObservationId: turn.proposal ? report.observations[index + 1]?.observationId : undefined })),
        procedure: report.procedure?.steps.map(step => ({ goalIds: step.goalIds,
          operation: step.operation, targets: step.targetStrategies.map(item => item.target),
          expectedTransition: step.expectedTransition })),
        cleanStart: report.result.cleanStart, coverage: report.result.requirementCoverage,
        cleanupVerified: report.result.cleanupVerified })}`);
      const firstProposal = report.trace.proposals.find(proposal => proposal.kind === 'interact');
      const firstObservation = firstProposal?.kind === 'interact'
        ? report.observations.find(item => item.observationId === firstProposal.observationId) : undefined;
      const firstTarget = (() => {
        if (firstProposal?.kind !== 'interact') return undefined;
        const target = firstProposal.target;
        if (target.kind === 'role_name') return target;
        if (target.kind === 'element_ref') return firstObservation?.dom.elements.find(
          item => item.ref === target.ref);
        return undefined;
      })();
      results.push({ variant, outcome: report.result.outcome,
        firstAction: firstProposal?.kind === 'interact' && firstObservation &&
          firstTarget?.role && firstTarget.name
          ? { operation: firstProposal.operation, target: { role: firstTarget.role, name: firstTarget.name },
            page: new URL(firstObservation.url).pathname } : undefined,
        subsequentObservationUsed: turns.some((turn, index) => index > 0 &&
          report.explorationActions.some(action => action.afterObservationId === turn.observationId)),
        visualDiscovery: report.trace.proposals.some(proposal => {
          if (proposal.kind !== 'interact') return false;
          const target = proposal.target;
          return report.observations.some(observation => observation.observationId === proposal.observationId &&
            !!observation.screenshot && (target.kind === 'visual_coordinate' ||
              target.kind === 'element_ref' && observation.dom.elements.some(element =>
                element.ref === target.ref && !element.name)));
        }) &&
          turns.some(turn => turn.imageProvided && !turn.cleanVisual) &&
          report.cleanVisualModelCalls === 1 });
    } catch (error) {
      console.log(`ADAPTIVE_LIVE_${variant.toUpperCase()}=${JSON.stringify({
        model: adapter.model, outcome: 'HARNESS_ERROR',
        error: error instanceof Error ? error.message : 'UNKNOWN_ERROR', modelCalls: turns.length, turns })}`);
      results.push({ variant, outcome: 'HARNESS_ERROR', firstAction: undefined,
        subsequentObservationUsed: false, visualDiscovery: false });
    }
  }
  expect(results.map(item => item.outcome)).toEqual(variants.map(() => 'VERIFIED_PASS'));
  expect(results.every(item => item.subsequentObservationUsed)).toBe(true);
  if (!liveVariant) {
    expect(results[0]?.firstAction).toEqual({ operation: 'click',
      target: { role: 'link', name: 'Account settings' }, page: '/' });
    expect(results[1]?.firstAction).toEqual({ operation: 'click',
      target: { role: 'button', name: 'Profile' }, page: '/' });
  }
  const visual = results.find(item => item.variant === 'c');
  expect(visual?.firstAction).toBeUndefined();
  expect(visual?.visualDiscovery).toBe(true);
});
