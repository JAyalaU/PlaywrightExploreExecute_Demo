import { expect, test } from '@playwright/test';
import { authoredDigest, type AgentProposalV1, type RequirementLedgerV1,
  type TaskEnvelopeV1 } from '../app/adaptive/contracts.js';
import { AdaptiveBrowser, observedViewportRegion } from '../app/adaptive/browser.js';
import { runAdaptiveVerticalSlice } from '../app/adaptive/vertical-slice.js';
import type { ReasoningModel } from '../app/adaptive/interfaces.js';
import { GatewayRejectionV1, validateGatewayProposal, type TrustedGatewayStateV1 } from
  '../app/adaptive/action-gateway.js';
import { OpenAIAdaptiveReasoningModel } from '../app/adaptive/openai-reasoning.js';
import type { ReasoningContextV1 } from '../app/adaptive/interfaces.js';
import { startAdaptiveFixture } from './support/adaptive-fixture.js';

const instruction = 'Open my account settings, enable email notifications, and verify that email notifications are enabled.';
const makeTask = (baseUrl: string): TaskEnvelopeV1 => ({ version: '1', taskId: 'visualTest',
  authoredInstruction: instruction, authoredDigest: authoredDigest(instruction),
  startUrl: `${baseUrl}/`, approvalRef: 'localFixture',
  operatorConstraints: { allowedOrigins: [baseUrl], prohibitedEffects: [],
    confirmationRequiredEffects: [], allowedOperations: ['click', 'check'],
    budgets: { maxActions: 8, maxObservations: 12, maxScreenshots: 2 } } });

test('browser captures current viewport JPEG and guarded gear click requires a fresh observation', async ({ page }) => {
  const fixture = await startAdaptiveFixture('c', () => 1);
  try {
    const browser = new AdaptiveBrowser(page, async () => {});
    const task = makeTask(fixture.baseUrl);
    const first = await browser.observeInitial(task);
    expect(first.dom.elements.some(item => /settings/i.test(item.name ?? ''))).toBe(false);
    const observed = await browser.captureScreenshot(first.observationId);
    expect(observed.screenshot).toMatchObject({ sessionId: observed.sessionId,
      pageId: observed.pageId, documentRevision: observed.documentRevision,
      coordinateFrameId: observed.coordinateFrameId, viewport: observed.viewport,
      scrollX: 0, scrollY: 0 });
    expect(browser.getScreenshotData(observed.screenshot!.ref)).toMatch(/^data:image\/jpeg;base64,/);
    const gear = page.locator('header button');
    const box = await gear.boundingBox();
    expect(box).toBeTruthy();
    const proposal: AgentProposalV1 = { version: '1', proposalId: 'visualClick',
      kind: 'interact', operation: 'click', observationId: observed.observationId,
      goalId: 'openSettings', predictedEffect: 'Account settings opens',
      target: { kind: 'visual_coordinate', screenshotRef: observed.screenshot!.ref,
        coordinateFrameId: observed.coordinateFrameId, viewport: observed.viewport,
        x: box!.x + box!.width / 2, y: box!.y + box!.height / 2,
        description: 'gear icon', context: 'right side of the account header' } };
    const policy: TrustedGatewayStateV1 = { task, currentObservation: observed,
      binding: { observationId: observed.observationId, sessionId: observed.sessionId,
        pageId: observed.pageId, documentRevision: observed.documentRevision,
        coordinateFrameId: observed.coordinateFrameId,
        screenshotRef: observed.screenshot!.ref, scrollX: 0, scrollY: 0 },
      usedActions: 0, usedObservations: 2, usedScreenshots: 1,
      unresolvedGoalIds: new Set(['openSettings']), visualCoordinateDispatchVerified: true,
      authorizedRiskClasses: new Set(['state_changing']), confirmedEffects: new Set(),
      classifyInteraction: () => ({ risk: 'state_changing', effect: 'click' }) };
    const unnamedRef = { ...proposal,
      target: { kind: 'element_ref', ref: observed.dom.elements[0]!.ref } };
    expect(validateGatewayProposal(unnamedRef, policy)).toEqual(unnamedRef);
    expect(observed.dom.elements[0]?.bounds).toBeTruthy();
    expect(observed.dom.elements[0]?.visual?.kind).toBe('svg_icon');
    expect(observed.dom.elements[0]?.visual?.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateGatewayProposal(unnamedRef, { ...policy,
      currentObservation: { ...observed, dom: { ...observed.dom, elements: [
        ...observed.dom.elements, { ...observed.dom.elements[0], ref: 'eAnother' } ] } } }))
      .toThrow(new GatewayRejectionV1('TARGET_NOT_GROUNDED'));
    expect(() => validateGatewayProposal(unnamedRef, { ...policy,
      currentObservation: { ...observed, screenshot: undefined } }))
      .toThrow(new GatewayRejectionV1('STALE_OBSERVATION'));
    expect(validateGatewayProposal(proposal, policy)).toEqual(proposal);
    await browser.dispatch(proposal as Extract<AgentProposalV1, { kind: 'interact' }>, observed);
    const after = await browser.observeCurrent();
    expect(new URL(after.url).pathname).toBe('/settings');
    expect(after.dom.elements.some(item => item.role === 'checkbox' &&
      item.name === 'Email notifications')).toBe(true);
    expect(() => browser.getScreenshotData(observed.screenshot!.ref)).toThrow('SCREENSHOT_NOT_CURRENT');
    const reject = (candidate: unknown, state = policy, code: GatewayRejectionV1['code'] =
      'VISUAL_BINDING_INVALID') => expect(() => validateGatewayProposal(candidate, state))
      .toThrow(new GatewayRejectionV1(code));
    reject(proposal, { ...policy, currentObservation: { ...observed, screenshot: undefined } },
      'STALE_OBSERVATION');
    reject({ ...proposal, target: { ...proposal.target, screenshotRef: 'oldImage' } });
    reject({ ...proposal, target: { ...proposal.target, x: observed.viewport.width } });
    reject({ ...proposal, target: { ...proposal.target, viewport: {
      ...observed.viewport, width: observed.viewport.width + 1 } } });
    reject(proposal, { ...policy, currentObservation: { ...observed, screenshot: {
      ...observed.screenshot!, scrollY: 40 } } }, 'STALE_OBSERVATION');
    reject(proposal, { ...policy, binding: { ...policy.binding, sessionId: 'other' } },
      'STALE_OBSERVATION');
    reject(proposal, { ...policy, authorizedRiskClasses: new Set(['read']) }, 'RISK_DENIED');
    reject({ ...proposal, operation: 'check' }, policy, 'UNSUPPORTED_OPERATION');
    const old = { ...observed, screenshot: { ...observed.screenshot!,
      observedAt: new Date(Date.now() - 60_000).toISOString() } };
    reject(proposal, { ...policy, currentObservation: old });
  } finally { await fixture.close(); }
});

test('Responses receives screenshot bytes as image input and rejects unsupported image model', async ({ page }) => {
  const fixture = await startAdaptiveFixture('c', () => 1);
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  try {
    const browser = new AdaptiveBrowser(page, async () => {});
    const task = makeTask(fixture.baseUrl);
    const first = await browser.observeInitial(task);
    const observation = await browser.captureScreenshot(first.observationId);
    const proposal: AgentProposalV1 = { version: '1', proposalId: 'imageProposal',
      kind: 'observe', observationId: observation.observationId,
      scope: 'page', modality: 'accessibility' };
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'mock_response', object: 'response',
        status: 'completed', model: 'gpt-6.1-sol', output: [{ id: 'mock_message', type: 'message',
          role: 'assistant', status: 'completed', content: [{ type: 'output_text',
            text: JSON.stringify(proposal), annotations: [] }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const context: ReasoningContextV1 = { original: { taskId: task.taskId,
      authoredInstruction: task.authoredInstruction, authoredDigest: task.authoredDigest,
      startUrl: task.startUrl },
      ledger: { version: '1', taskId: task.taskId, authoredDigest: task.authoredDigest,
        authoredGoals: [], inferredPrerequisites: [], unresolvedQuestions: [] },
      observation, screenshotDataUrl: browser.getScreenshotData(observation.screenshot!.ref),
      validatedHistory: [], unresolvedGoalIds: [], availableOperations: ['click', 'observe'],
      maxContextCharacters: 24_000 };
    expect(await new OpenAIAdaptiveReasoningModel('test-key', 'gpt-6.1-sol').propose(context))
      .toEqual(proposal);
    const request = requests[0]!;
    const input = request.input as { role: string; content: { type: string;
      image_url?: string }[] }[];
    expect(input[0]?.content[1]).toMatchObject({ type: 'input_image',
      image_url: context.screenshotDataUrl });
    expect(input[0]?.content[0]?.type).toBe('input_text');
    await expect(new OpenAIAdaptiveReasoningModel('test-key', 'unknown-model').propose(context))
      .rejects.toThrow('MODEL_IMAGE_INPUT_UNSUPPORTED');
    expect(requests).toHaveLength(1);
  } finally { globalThis.fetch = originalFetch; await fixture.close(); }
});

test('browser rejects visual evidence after live viewport or scroll changes', async ({ page }) => {
  const fixture = await startAdaptiveFixture('c', () => 1);
  try {
    const browser = new AdaptiveBrowser(page, async () => {});
    const task = makeTask(fixture.baseUrl);
    const initial = await browser.observeInitial(task);
    const screenshot = await browser.captureScreenshot(initial.observationId);
    await page.setViewportSize({ width: screenshot.viewport.width - 100,
      height: screenshot.viewport.height });
    await expect(browser.assertCurrent(screenshot)).rejects.toThrow('STALE_LIVE_PAGE');
    const updated = await browser.observeCurrent();
    await page.evaluate(() => { document.body.style.minHeight = '3000px'; });
    const withHeight = await browser.observeCurrent();
    const scrolledEvidence = await browser.captureScreenshot(withHeight.observationId);
    expect(scrolledEvidence.screenshot?.scrollY).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 200));
    await expect(browser.assertCurrent(scrolledEvidence)).rejects.toThrow('STALE_LIVE_PAGE');
    expect(updated.viewport.width).toBe(screenshot.viewport.width - 100);
  } finally { await fixture.close(); }
});

test('unnamed observed ref dispatch rechecks screenshot pixels and observed transition', async ({ page }) => {
  const fixture = await startAdaptiveFixture('c', () => 1);
  try {
    const browser = new AdaptiveBrowser(page, async () => {});
    const task = makeTask(fixture.baseUrl);
    const initial = await browser.observeInitial(task);
    const observation = await browser.captureScreenshot(initial.observationId);
    const proposal: Extract<AgentProposalV1, { kind: 'interact' }> = {
      version: '1', proposalId: 'unnamedRef', kind: 'interact', operation: 'click',
      observationId: observation.observationId, goalId: 'openSettings',
      target: { kind: 'element_ref', ref: observation.dom.elements[0]!.ref },
      predictedEffect: 'Account settings opens' };
    await page.evaluate(() => { document.querySelector('header')!.style.background = 'red'; });
    await expect(browser.dispatch(proposal, observation)).rejects.toThrow('STALE_SCREENSHOT');
    const refreshed = await browser.observeCurrent();
    const screenshot = await browser.captureScreenshot(refreshed.observationId);
    await browser.dispatch({ ...proposal, observationId: screenshot.observationId,
      target: { kind: 'element_ref', ref: screenshot.dom.elements[0]!.ref } }, screenshot);
    const after = await browser.observeCurrent();
    expect(new URL(after.url).pathname).toBe('/settings');
  } finally { await fixture.close(); }
});

test('fresh visual anchor requires matching role, icon signature and control bounds', async ({ page }) => {
  const fixture = await startAdaptiveFixture('c', () => 1);
  try {
    const browser = new AdaptiveBrowser(page, async () => {});
    const initial = await browser.observeInitial(makeTask(fixture.baseUrl));
    const observed = await browser.captureScreenshot(initial.observationId);
    const control = observed.dom.elements[0]!;
    const bounds = control.bounds!;
    const target = { kind: 'visual_coordinate' as const, screenshotRef: observed.screenshot!.ref,
      coordinateFrameId: observed.coordinateFrameId, viewport: observed.viewport,
      x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
      description: 'unnamed button with SVG icon', context: 'account header' };
    const anchor = { kind: 'visual_anchor' as const, description: target.description,
      context: target.context, observedRole: control.role!, visualKind: control.visual!.kind,
      visualSignature: control.visual!.signature!,
      viewportRegion: observedViewportRegion(bounds, observed.viewport) };
    expect(browser.matchesVisualAnchor(anchor, target, observed)).toBe(true);
    const freshRef = { kind: 'element_ref' as const, ref: control.ref };
    expect(browser.matchesVisualAnchor(anchor, freshRef, observed)).toBe(true);
    expect(browser.matchesVisualAnchor({ ...anchor, observedRole: 'link' }, target, observed)).toBe(false);
    expect(browser.matchesVisualAnchor({ ...anchor, observedRole: 'link' }, freshRef, observed)).toBe(false);
    expect(browser.matchesVisualAnchor({ ...anchor, visualSignature: '0'.repeat(64) },
      target, observed)).toBe(false);
    expect(browser.matchesVisualAnchor({ ...anchor, visualSignature: '0'.repeat(64) },
      freshRef, observed)).toBe(false);
    expect(browser.matchesVisualAnchor({ ...anchor, viewportRegion: 'bottom_left' },
      freshRef, observed)).toBe(false);
    expect(browser.matchesVisualAnchor({ ...anchor, visualSignature: undefined },
      freshRef, observed)).toBe(false);
    expect(browser.matchesVisualAnchor(anchor, { kind: 'element_ref', ref: 'oldRef' },
      observed)).toBe(false);
    expect(browser.matchesVisualAnchor(anchor, { ...target, x: 5, y: 5 }, observed)).toBe(false);
    expect(browser.matchesVisualAnchor(anchor, { ...target, screenshotRef: 'oldScreenshot' },
      observed)).toBe(false);
  } finally { await fixture.close(); }
});

test('unnamed ref becomes stale when bounds move or the document is replaced', async ({ page }) => {
  const fixture = await startAdaptiveFixture('c', () => 1);
  try {
    const browser = new AdaptiveBrowser(page, async () => {});
    const initial = await browser.observeInitial(makeTask(fixture.baseUrl));
    const observed = await browser.captureScreenshot(initial.observationId);
    const proposal: Extract<AgentProposalV1, { kind: 'interact' }> = {
      version: '1', proposalId: 'staleRef', kind: 'interact', operation: 'click',
      observationId: observed.observationId, goalId: 'openSettings',
      target: { kind: 'element_ref', ref: observed.dom.elements[0]!.ref },
      predictedEffect: 'Account settings opens' };
    await page.evaluate(() => { (document.querySelector('header button') as HTMLElement).style.transform =
      'translateX(-80px)'; });
    await expect(browser.dispatch(proposal, observed)).rejects.toThrow('STALE_LIVE_PAGE');
    const moved = await browser.observeCurrent();
    const current = await browser.captureScreenshot(moved.observationId);
    await page.reload();
    await expect(browser.dispatch({ ...proposal, observationId: current.observationId,
      target: { kind: 'element_ref', ref: current.dom.elements[0]!.ref } }, current))
      .rejects.toThrow('STALE_LIVE_PAGE');
  } finally { await fixture.close(); }
});

async function runBudgetedVisualCase(browserOwner: import('@playwright/test').Browser,
  mode: 'expire_before_clean_model' | 'expire_after_clean_model' | 'stale_clean_ref') {
  let opened = 0, elapsed = 0, cleanCalls = 0, explorationScreenshotObservationId = '';
  const fixture = await startAdaptiveFixture('c', () => opened);
  try {
    const task = { ...makeTask(fixture.baseUrl), stateResetRef: 'fixture_reset' };
    const phrases = ['Open my account settings', 'enable email notifications',
      'verify that email notifications are enabled'];
    const kinds = ['required_action', 'outcome', 'assertion'] as const;
    const ledger: RequirementLedgerV1 = { version: '1', taskId: task.taskId,
      authoredDigest: task.authoredDigest, authoredGoals: phrases.map((requirement, index) => ({
        goalId: `g${index}`, kind: kinds[index]!, requirement,
        sourceSpan: { start: instruction.indexOf(requirement),
          end: instruction.indexOf(requirement) + requirement.length },
        interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] })),
      inferredPrerequisites: [], unresolvedQuestions: [] };
    let proposalNumber = 0;
    const model: ReasoningModel = { async interpretRequirements({ observation }) {
      return { ledger, acceptancePlan: { version: '1', taskId: task.taskId,
        authoredDigest: task.authoredDigest, sourceObservationId: observation.observationId,
        goals: ledger.authoredGoals.map(goal => ({ goalId: goal.goalId, kind: goal.kind,
          sourceSpan: goal.sourceSpan, requirement: goal.requirement, status: 'hypothesis' as const,
          predicates: goal.goalId === 'g0'
            ? [{ kind: 'url' as const, comparison: 'path_equals' as const, value: '/settings' }]
            : [{ kind: 'element' as const, role: 'checkbox', name: 'Email notifications',
              property: 'checked' as const, equals: true }],
          ...(goal.goalId === 'g0' ? { action: { operation: 'click' as const, afterGoalIds: [] } } : {}) })) } };
    }, async propose(context) {
      const observation = context.observation;
      const proposalId = `budgetProposal${++proposalNumber}`;
      if (context.cleanVisualTarget) {
        cleanCalls++;
        if (mode === 'expire_after_clean_model') elapsed = 31;
        return { version: '1', proposalId, kind: 'interact', operation: 'click',
          goalId: context.cleanVisualTarget.goalId,
          observationId: mode === 'stale_clean_ref' ? explorationScreenshotObservationId
            : observation.observationId,
          target: { kind: 'element_ref', ref: observation.dom.elements[0]!.ref },
          predictedEffect: context.cleanVisualTarget.expectedTransition };
      }
      if (observation.url.endsWith('/') && !observation.screenshot)
        return { version: '1', proposalId, kind: 'observe', observationId: observation.observationId,
          scope: 'page', modality: 'screenshot' };
      if (observation.url.endsWith('/')) {
        explorationScreenshotObservationId = observation.observationId;
        return { version: '1', proposalId, kind: 'interact', operation: 'click',
          observationId: observation.observationId, goalId: 'g0',
          target: { kind: 'element_ref', ref: observation.dom.elements[0]!.ref },
          predictedEffect: 'Settings opens' };
      }
      const checkbox = observation.dom.elements.find(item => item.role === 'checkbox')!;
      if (!checkbox.checked) return { version: '1', proposalId, kind: 'interact',
        operation: 'check', observationId: observation.observationId, goalId: 'g1',
        target: { kind: 'element_ref', ref: checkbox.ref },
        predictedEffect: 'Email notifications enabled' };
      const goalId = context.unresolvedGoalIds.includes('g1') ? 'g1' : 'g2';
      return { version: '1', proposalId, kind: 'verify', goalId,
        observationId: observation.observationId,
        predicate: { kind: 'element_state', target: { kind: 'role_name',
          role: 'checkbox', name: 'Email notifications' }, property: 'checked', equals: true } };
    } };
    const report = await runAdaptiveVerticalSlice({ task, model,
      reset: fixture.reset, now: () => elapsed,
      openBrowser: async () => {
        opened++;
        const context = await browserOwner.newContext();
        const browser = new AdaptiveBrowser(await context.newPage(), () => context.close());
        if (opened === 2 && mode === 'expire_before_clean_model') {
          const capture = browser.captureScreenshot.bind(browser);
          browser.captureScreenshot = async (observationId, focus) => {
            const result = await capture(observationId, focus);
            elapsed = 31;
            return result;
          };
        }
        return browser;
      }, maxModelTurns: 8, maxElapsedMs: 30, maxIneffectiveActions: 2 });
    return { report, cleanCalls };
  } finally { await fixture.close(); }
}

test('clean screenshot time is charged before another model call', async ({ browser }) => {
  const { report, cleanCalls } = await runBudgetedVisualCase(browser, 'expire_before_clean_model');
  expect(cleanCalls).toBe(0);
  expect(report.cleanVisualModelCalls).toBe(0);
  expect(report.stopReason).toBe('TIME_BUDGET_EXCEEDED');
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.result.actionEvidenceIds).toHaveLength(0);
  expect(report.timingsMs.cleanExecution).toBe(31);
  expect(report.timingsMs.total).toBe(31);
  expect(report.result.cleanupVerified).toBe(true);
});

test('clean model time is charged before a fresh ref may dispatch', async ({ browser }) => {
  const { report, cleanCalls } = await runBudgetedVisualCase(browser, 'expire_after_clean_model');
  expect(cleanCalls).toBe(1);
  expect(report.cleanVisualModelCalls).toBe(1);
  expect(report.stopReason).toBe('TIME_BUDGET_EXCEEDED');
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.result.actionEvidenceIds).toHaveLength(0);
  expect(report.result.cleanupVerified).toBe(true);
});

test('clean ref from exploration observation cannot dispatch in fresh session', async ({ browser }) => {
  const { report, cleanCalls } = await runBudgetedVisualCase(browser, 'stale_clean_ref');
  expect(cleanCalls).toBe(1);
  expect(report.stopReason).toBe('CLEAN_VISUAL_REIDENTIFICATION_FAILED');
  expect(report.result.outcome).toBe('BLOCKED');
  expect(report.result.actionEvidenceIds).toHaveLength(0);
  expect(report.cleanVisualReidentifications).toHaveLength(0);
  expect(report.result.cleanupVerified).toBe(true);
});
