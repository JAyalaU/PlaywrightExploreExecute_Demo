import { expect, test } from '@playwright/test';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { fixtureResetTask, MinimalBrowserTools } from '../app/adaptive-minimal/browser-tools.js';
import { runMinimalAdaptiveAgent } from '../app/adaptive-minimal/controller.js';
import { OpenAIMinimalModel } from '../app/adaptive-minimal/model.js';
import type { BrowserAction, Choice, EvaluationInput, MinimalModel, MinimalTask, ModelTurn,
  Verdict } from '../app/adaptive-minimal/types.js';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { startAdaptiveFixture } from './support/adaptive-fixture.js';
import type { ObservationV1 } from '../app/adaptive/contracts.js';

function task(baseUrl: string, instruction = 'Open account settings and turn on Email notifications.',
  resetRef = 'fixture_reset'): MinimalTask {
  return { instruction, startUrl: `${baseUrl}/`, allowedOrigins: [baseUrl],
    resetRef, maxModelTurns: 9, maxActions: 5,
    maxScreenshots: 2, maxElapsedMs: 45_000 };
}
function factory() {
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_minimal_test', version: '1',
    browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} },
    profileSchemaVersion: '5', presentationMode: 'headless',
    browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows' }]);
  return new ProtectedContextFactory(catalog);
}
class ScriptedModel implements MinimalModel {
  readonly visualClicks: { phase: string; x: number; image: boolean }[] = [];
  evaluationScreenshotCount = 0;
  constructor(readonly verdict: 'auto' | 'inconclusive' | 'invalid_id' | 'fail' = 'auto') {}
  async choose(input: ModelTurn): Promise<Choice> {
    if (this.verdict === 'inconclusive' || this.verdict === 'invalid_id')
      return { kind: 'done', reason: 'No supported action' };
    const observation = input.observation;
    const checkbox = observation.dom.elements.find(item => item.role === 'checkbox' &&
      item.name === 'Email notifications');
    if (checkbox && !checkbox.checked) return { kind: 'act', operation: 'check',
      observationId: observation.observationId,
      target: { kind: 'role_name', role: 'checkbox', name: 'Email notifications' } };
    if (checkbox) {
      if (!input.recentReceipts.some(item => item.action.kind === 'navigate'))
        return { kind: 'navigate', observationId: observation.observationId, url: observation.url };
      return { kind: 'done', reason: 'Checkbox still checked after reload' };
    }
    const link = observation.dom.elements.find(item => item.role === 'link' &&
      item.name === 'Account settings');
    if (link) return { kind: 'act', operation: 'click', observationId: observation.observationId,
      target: { kind: 'role_name', role: 'link', name: 'Account settings' } };
    const gear = observation.dom.elements.find(item => item.role === 'button' && !item.name &&
      item.visual?.kind === 'svg_icon');
    if (gear && !observation.screenshot) return { kind: 'observe', modality: 'screenshot' };
    if (gear?.bounds && observation.screenshot) {
      this.visualClicks.push({ phase: input.phase,
        x: gear.bounds.x + gear.bounds.width / 2, image: !!input.screenshotDataUrl });
      return { kind: 'act', operation: 'click', observationId: observation.observationId,
        target: { kind: 'visual_coordinate', x: gear.bounds.x + gear.bounds.width / 2,
          y: gear.bounds.y + gear.bounds.height / 2, description: 'gear icon in account header' } };
    }
    return { kind: 'stuck', reason: 'Target unavailable' };
  }
  async evaluate(input: EvaluationInput): Promise<Verdict> {
    this.evaluationScreenshotCount = input.screenshots?.length ?? 0;
    if (this.verdict === 'invalid_id') return { outcome: 'PASS', explanation: 'Invalid citation',
      evidenceIds: ['invented_evidence', input.finalObservation.observationId] };
    if (this.verdict === 'inconclusive') return { outcome: 'INCONCLUSIVE',
      explanation: 'No clean interaction established the requested outcome',
      evidenceIds: [input.finalObservation.observationId] };
    if (this.verdict === 'fail') return { outcome: 'FAIL',
      explanation: 'Clean browser remained on the wrong page without the requested checkbox',
      evidenceIds: [input.finalObservation.observationId] };
    const checkbox = input.finalObservation.dom.elements.find(item => item.role === 'checkbox' &&
      item.name === 'Email notifications');
    const changed = input.receipts.find(item => item.delivery === 'returned' && item.observedChange);
    return { outcome: checkbox?.checked && changed ? 'PASS' : 'INCONCLUSIVE',
      explanation: checkbox?.checked && changed ? 'Clean action changed the UI and checkbox remained checked' :
        'Clean evidence was incomplete',
      evidenceIds: [input.finalObservation.observationId, ...(changed ? [changed.id] : [])] };
  }
}

async function runVariant(variant: 'a' | 'c', model: ScriptedModel, destinationDrift = false,
  freshNavigation = false,
  onCleanFinalScreenshot?: (image: { observationId: string; dataUrl: string }) => Promise<void>) {
  let browsers = 0;
  const fixture = await startAdaptiveFixture(variant, () => browsers);
  fixture.setDestinationDrift(destinationDrift);
  const minimalTask = task(fixture.baseUrl, undefined, freshNavigation ? 'fresh_navigation' : 'fixture_reset');
  const contextFactory = factory();
  try {
    const report = await runMinimalAdaptiveAgent({ task: minimalTask, model,
      ...(onCleanFinalScreenshot ? { onCleanFinalScreenshot } : {}),
      reset: async current => freshNavigation
        ? { kind: 'fresh_navigation', freshBrowserContext: true,
          applicationStateVerified: false, resetRef: 'fresh_navigation' }
        : fixture.reset.prepareCleanState(fixtureResetTask(current)),
      openBrowser: async () => {
        browsers++;
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      } });
    return { report, browsers, oracle: await fixture.state() };
  } finally { await fixture.close(); }
}

test('accessible settings navigation and checkbox survive a clean attempt', async () => {
  const { report, browsers, oracle } = await runVariant('a', new ScriptedModel());
  expect(report.outcome).toBe('PASS');
  expect(browsers).toBe(2);
  expect(oracle).toBe(true);
  expect(report.clean?.resetProof.applicationStateVerified).toBe(true);
  expect(report.clean?.receipts.some(item => item.action.kind === 'navigate')).toBe(true);
});

test('screenshot gear is found again at a changed position in a fresh context', async () => {
  const model = new ScriptedModel();
  const finalImages: { observationId: string; dataUrl: string }[] = [];
  const { report, oracle } = await runVariant('c', model, false, false,
    async image => { finalImages.push(image); });
  expect(report.outcome).toBe('PASS');
  expect(oracle).toBe(true);
  expect(model.visualClicks).toHaveLength(2);
  expect(model.visualClicks.map(item => item.phase)).toEqual(['discovery', 'clean']);
  expect(model.visualClicks.every(item => item.image)).toBe(true);
  expect(model.evaluationScreenshotCount).toBeGreaterThan(0);
  expect(model.visualClicks[0]!.x).not.toBe(model.visualClicks[1]!.x);
  expect(report.discovery.observations[0]!.sessionId).not.toBe(report.clean!.observations[0]!.sessionId);
  expect(report.clean?.receipts[0]?.action.kind).toBe('act');
  expect(finalImages).toHaveLength(1);
  expect(finalImages[0]?.observationId).toBe(report.clean?.observations.at(-1)?.observationId);
  expect(finalImages[0]?.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
});

test('failed post-click accessibility observation retains bounded browser facts', async () => {
  const fixture = await startAdaptiveFixture('a', () => 0);
  const contextFactory = factory();
  class FailingPostClickBrowser extends AdaptiveBrowser {
    private reads = 0;
    override async observeCurrent(): Promise<ObservationV1> {
      if (++this.reads === 2)
        throw new Error("locator('body').ariaSnapshot: Timeout 5000ms exceeded");
      return super.observeCurrent();
    }
  }
  try {
    const report = await runMinimalAdaptiveAgent({ task: task(fixture.baseUrl),
      model: new ScriptedModel(),
      reset: current => fixture.reset.prepareCleanState(fixtureResetTask(current)),
      openBrowser: async () => {
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new FailingPostClickBrowser(await session.context.newPage(), () => session.close());
      } });
    expect(report.outcome).toBe('INCONCLUSIVE');
    expect(report.discovery.receipts[0]?.delivery).toBe('returned');
    expect(report.discovery.receipts[0]?.afterId).toBeUndefined();
    expect(report.discovery.receipts[0]?.diagnostic).toMatchObject({
      bodyAttached: true, ariaSnapshotTimedOut: true });
    expect(report.discovery.receipts[0]?.diagnostic?.currentUrl).toContain('/settings');
  } finally { await fixture.close(); }
});

test('insufficient clean evidence is inconclusive', async () => {
  const { report } = await runVariant('a', new ScriptedModel('inconclusive'));
  expect(report.outcome).toBe('INCONCLUSIVE');
  expect(report.clean?.receipts).toHaveLength(0);
});

test('fresh navigation proves the start page without claiming application reset', async () => {
  const { report } = await runVariant('a', new ScriptedModel('inconclusive'), false, true);
  expect(report.outcome).toBe('INCONCLUSIVE');
  expect(report.clean?.resetProof.initialNavigationVerified).toBe(true);
  expect(report.clean?.resetProof.applicationStateVerified).toBe(false);
});

test('observed wrong destination can produce FAIL', async () => {
  const { report } = await runVariant('a', new ScriptedModel('fail'), true);
  expect(report.outcome).toBe('FAIL');
  expect(report.clean?.observations.at(-1)?.url).toContain('/other-settings');
});

test('evaluator cannot cite evidence that does not exist', async () => {
  const { report } = await runVariant('a', new ScriptedModel('invalid_id'));
  expect(report.outcome).toBe('INCONCLUSIVE');
  expect(report.explanation).toContain('EVALUATOR_EVIDENCE_INVALID');
});

test('independent evaluator sends clean screenshot evidence as image input', async () => {
  const observation: EvaluationInput['finalObservation'] = { version: '1',
    observationId: 'o_test', sessionId: 's_test', pageId: 'p_test',
    documentRevision: 'rev_test', coordinateFrameId: 'o_test',
    url: 'https://example.org/', observedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 720, scale: 1 },
    accessibility: { snapshotRef: 'a_test', summary: 'A gray box' },
    dom: { factsRef: 'd_test', complete: true, summary: 'Example', elements: [] } };
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'mock_response', object: 'response',
      status: 'completed', model: 'gpt-6.1-sol', output: [{ id: 'mock_message',
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ outcome: 'INCONCLUSIVE',
          explanation: 'Insufficient evidence', evidenceIds: ['o_test'] }), annotations: [] }] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const model = new OpenAIMinimalModel('test-secret', 'gpt-6.1-sol');
    await model.evaluate({ instruction: 'Check the gray box', observations: [observation],
      receipts: [], finalObservation: observation,
      screenshots: [{ observationId: 'o_test', dataUrl: 'data:image/jpeg;base64,AA==' }] });
  } finally { globalThis.fetch = originalFetch; }
  const content = (request?.input as { content: { type: string }[] }[])[0]!.content;
  expect(content.map(item => item.type)).toEqual(['input_text', 'input_image']);
  expect(JSON.stringify(request)).not.toContain('test-secret');
});

test('ordinary Remove and Delete actions and distinct unnamed checkboxes use current browser evidence', async () => {
  const fixture = await startAdaptiveFixture('a', () => 0);
  const session = await factory().open({ id: 'adaptive_minimal_test', version: '1' });
  try {
    const page = await session.context.newPage();
    const browser = new AdaptiveBrowser(page, () => session.close());
    const tools = new MinimalBrowserTools(browser, task(fixture.baseUrl));
    await tools.start();
    await page.setContent('<!doctype html><title>Generic controls</title>' +
      '<button onclick="document.getElementById(\'remove-me\').remove()">Remove</button>' +
      '<button onclick="document.getElementById(\'delete-me\').remove()">Delete</button>' +
      '<button onclick="document.getElementById(\'account\').remove()">Delete account</button>' +
      '<span id="remove-me">One</span><span id="delete-me">Two</span>' +
      '<span id="account">Account</span>' +
      '<input id="first" type="checkbox"><input id="second" type="checkbox">' +
      '<input type="checkbox" aria-label="Shared"><input type="checkbox" aria-label="Shared">');
    let observation = await tools.observe();
    const action = (current: ObservationV1, operation: 'click' | 'check' | 'uncheck',
      target: Extract<BrowserAction, { kind: 'act' }>['target']): BrowserAction => ({
      kind: 'act', observationId: current.observationId, operation, target });
    observation = await tools.screenshot(observation);
    const remove = observation.dom.elements.find(element => element.name === 'Remove')!;
    await tools.execute(action(observation, 'click',
      { kind: 'visual_coordinate', x: remove.bounds!.x + remove.bounds!.width / 2,
        y: remove.bounds!.y + remove.bounds!.height / 2,
        description: 'Remove button' }), observation);
    observation = await tools.observe();
    await tools.execute(action(observation, 'click',
      { kind: 'role_name', role: 'button', name: 'Delete' }), observation);
    observation = await tools.observe();
    expect(await page.locator('#remove-me, #delete-me').count()).toBe(0);
    await expect(tools.execute(action(observation, 'click',
      { kind: 'role_name', role: 'button', name: 'Delete account' }), observation))
      .rejects.toThrow('DANGEROUS_ACTION_DENIED');
    expect(await page.locator('#account').count()).toBe(1);
    observation = await tools.screenshot(observation);
    const boxes = observation.dom.elements.filter(element => element.role === 'checkbox' && !element.name);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.ref).not.toBe(boxes[1]?.ref);
    const oldObservation = observation;
    await tools.execute(action(observation, 'check',
      { kind: 'element_ref', ref: boxes[0]!.ref }), observation);
    observation = await tools.observe();
    expect(await page.locator('#first').isChecked()).toBe(true);
    expect(await page.locator('#second').isChecked()).toBe(false);
    await expect(tools.execute(action(oldObservation, 'check',
      { kind: 'element_ref', ref: boxes[1]!.ref }), oldObservation))
      .rejects.toThrow('STALE_LIVE_PAGE');
    await expect(tools.execute(action(oldObservation, 'check',
      { kind: 'element_ref', ref: boxes[1]!.ref }), observation))
      .rejects.toThrow('STALE_OBSERVATION');
    await expect(tools.execute(action(observation, 'check',
      { kind: 'role_name', role: 'checkbox', name: 'Shared' }), observation))
      .rejects.toThrow('TARGET_NOT_GROUNDED');
    const currentBoxes = observation.dom.elements.filter(
      element => element.role === 'checkbox' && !element.name);
    await tools.execute(action(observation, 'check',
      { kind: 'element_ref', ref: currentBoxes[1]!.ref }), observation);
    observation = await tools.observe();
    expect(await page.locator('#first').isChecked()).toBe(true);
    expect(await page.locator('#second').isChecked()).toBe(true);
    await tools.execute(action(observation, 'uncheck',
      { kind: 'element_ref', ref: observation.dom.elements.filter(
        element => element.role === 'checkbox' && !element.name)[0]!.ref }), observation);
    observation = await tools.observe();
    expect(await page.locator('#first').isChecked()).toBe(false);
    expect(await page.locator('#second').isChecked()).toBe(true);
    await expect(tools.execute({ kind: 'navigate', observationId: observation.observationId,
      url: 'https://example.com/' }, observation)).rejects.toThrow('NAVIGATION_DENIED');
    expect(page.url()).toBe(fixture.baseUrl + '/');
  } finally { await session.close(); await fixture.close(); }
});
