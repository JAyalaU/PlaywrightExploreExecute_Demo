import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { fixtureResetTask, MinimalBrowserTools } from '../app/adaptive-minimal/browser-tools.js';
import { runMinimalAdaptiveAgent } from '../app/adaptive-minimal/controller.js';
import { OpenAIMinimalModel } from '../app/adaptive-minimal/model.js';
import { ChoiceSchema, type BrowserAction, type Choice, type EvaluationInput,
  type MinimalModel, type MinimalTask, type ModelTurn,
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

async function startFormFixture() {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body><main><h1>Form controls</h1>
      <label>Username <input type="text" name="username"></label>
      <label>Password <input type="password" name="password"></label>
      <label>Amount <input type="number" name="amount"></label>
      <label>Choice <select name="choice"><option value="">Choose</option>
        <option value="2">Option 2</option><option value="3">Repeated</option>
        <option value="4">Repeated</option></select></label>
      <input aria-label="Key input"><p id="key-result"></p>
      <input aria-label="Duplicate"><input aria-label="Duplicate">
      <input type="number"><select><option value=""></option>
        <option value="9"></option></select><input type="text">
      <script>document.addEventListener('keydown', event => {
        document.getElementById('key-result').textContent = 'You entered: ' + event.key.toUpperCase();
      });</script></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error =>
      error ? reject(error) : resolve())) };
}

async function startHoverDialogFixture() {
  let visits = 0;
  const server = createServer((_request, response) => {
    const offset = ++visits === 1 ? 20 : 140;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><style>
      .avatars { display:flex; gap:20px; margin-left:${offset}px; }
      .card { width:80px; height:80px; background:#ccc; }
      .card::before { content:attr(data-avatar); }
      .caption { display:none; }
      .card-group:hover .caption { display:block; }
      </style></head><body><main><h1>Hover and dialog controls</h1>
      <div class="avatars"><div class="card-group"><button class="card"
        data-avatar="Avatar 1"></button><span class="caption">user1</span></div>
        <div class="card-group"><button class="card" data-avatar="Avatar 2"></button>
        <span class="caption">user2</span></div>
        <div class="card-group"><div class="card non-control" data-avatar="Avatar 3"></div>
        <span class="caption">user3</span></div></div>
      <button id="alert">Alert</button><button id="confirm">Confirm</button>
      <button id="prompt">Prompt</button><button id="normal">Normal</button>
      <p id="result"></p><script>
        const result = document.getElementById('result');
        document.getElementById('alert').onclick = () => {
          alert('Notice'); result.textContent = 'Alert accepted'; };
        document.getElementById('confirm').onclick = () => {
          result.textContent = confirm('Continue?') ? 'Confirmed' : 'Cancelled'; };
        document.getElementById('prompt').onclick = () => {
          result.textContent = 'Prompt: ' + prompt('Name?'); };
        document.getElementById('normal').onclick = () => {
          result.textContent = 'Normal clicked'; };
      </script></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error =>
      error ? reject(error) : resolve())) };
}

async function startPopupSliderFixture() {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/new') {
      response.end('<!doctype html><html><body><h1>New Window</h1></body></html>');
      return;
    }
    response.end(`<!doctype html><html><body><main><h1>Controls</h1>
      <a href="/new" target="_blank">Click Here</a>
      <a href="https://example.org/" target="_blank">External Window</a>
      <button type="button">Nothing</button>
      <input type="range" min="0" max="5" step="0.5" value="2.5">
      <span id="range-value">2.5</span>
      <input type="range" min="0" max="5" step="any" value="2.5">
      <input type="range" min="0" max="500" step="1" value="0">
      <script>document.querySelector('input[type="range"]').addEventListener('input', event => {
        document.getElementById('range-value').textContent = event.target.value;
      });</script></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error =>
      error ? reject(error) : resolve())) };
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

test('typed fill, native select, and focused key press observe real effects', async () => {
  const fixture = await startFormFixture();
  const session = await factory().open({ id: 'adaptive_minimal_test', version: '1' });
  try {
    const browser = new AdaptiveBrowser(await session.context.newPage(), () => session.close());
    const tools = new MinimalBrowserTools(browser, task(fixture.baseUrl));
    let observation = await tools.start();
    const ref = (name: string) => ({ kind: 'element_ref' as const,
      ref: observation.dom.elements.find(item => item.name === name)!.ref });
    expect(observation.dom.elements.find(item => item.options)?.options?.map(item => item.label))
      .toContain('Option 2');
    expect(ChoiceSchema.safeParse({ kind: 'press', observationId: observation.observationId,
      key: 'Control+X' }).success).toBe(false);
    expect(ChoiceSchema.safeParse({ kind: 'press', observationId: observation.observationId,
      key: 'ArrowLeft' }).success).toBe(true);
    expect(ChoiceSchema.safeParse({ kind: 'press', observationId: observation.observationId,
      key: 'ArrowRight' }).success).toBe(true);
    const first = observation;
    await tools.execute({ kind: 'act', operation: 'fill', observationId: observation.observationId,
      target: ref('Username'), value: 'tomsmith' }, observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.name === 'Username')?.value).toBe('tomsmith');
    await expect(tools.execute({ kind: 'act', operation: 'fill', observationId: first.observationId,
      target: { kind: 'role_name', role: 'input', name: 'Password' }, value: 'stale' }, first))
      .rejects.toThrow('STALE_LIVE_PAGE');
    await expect(tools.execute({ kind: 'act', operation: 'fill', observationId: observation.observationId,
      target: { kind: 'role_name', role: 'input', name: 'Duplicate' }, value: 'ambiguous' }, observation))
      .rejects.toThrow('TARGET_NOT_GROUNDED');
    await tools.execute({ kind: 'act', operation: 'fill', observationId: observation.observationId,
      target: ref('Password'), value: 'SuperSecretPassword!' }, observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.name === 'Password')).toMatchObject({
      inputType: 'password', valuePresent: true });
    expect(JSON.stringify(observation)).not.toContain('SuperSecretPassword!');
    await tools.execute({ kind: 'act', operation: 'fill', observationId: observation.observationId,
      target: ref('Amount'), value: '42' }, observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.name === 'Amount')?.value).toBe('42');
    const selectTarget = () => ({ kind: 'element_ref' as const,
      ref: observation.dom.elements.find(item => item.options)!.ref });
    await expect(tools.execute({ kind: 'act', operation: 'select_option',
      observationId: observation.observationId, target: selectTarget(),
      option: { kind: 'label', label: 'Repeated' } }, observation))
      .rejects.toThrow('SELECT_OPTION_NOT_UNIQUE');
    await tools.execute({ kind: 'act', operation: 'select_option',
      observationId: observation.observationId, target: selectTarget(),
      option: { kind: 'label', label: 'Option 2' } }, observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.options)?.options?.find(item =>
      item.label === 'Option 2')?.selected).toBe(true);
    await tools.execute({ kind: 'act', operation: 'click', observationId: observation.observationId,
      target: ref('Key input') }, observation);
    observation = await tools.observe();
    await tools.execute({ kind: 'press', observationId: observation.observationId,
      key: 'Escape' }, observation);
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('You entered: ESCAPE');
    await tools.execute({ kind: 'press', observationId: observation.observationId,
      key: 'Enter', target: ref('Key input') }, observation);
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('You entered: ENTER');
    const unnamedNumber = observation.dom.elements.find(item =>
      item.inputType === 'number' && !item.name)!;
    await tools.execute({ kind: 'act', operation: 'fill', observationId: observation.observationId,
      target: { kind: 'element_ref', ref: unnamedNumber.ref }, value: '7' }, observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.ref === unnamedNumber.ref)?.value).toBe('7');
    const unnamedSelect = observation.dom.elements.find(item => item.options && !item.name)!;
    await tools.execute({ kind: 'act', operation: 'select_option',
      observationId: observation.observationId,
      target: { kind: 'element_ref', ref: unnamedSelect.ref },
      option: { kind: 'value', value: '9' } }, observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.ref === unnamedSelect.ref)?.value).toBe('9');
    const unnamedText = observation.dom.elements.find(item =>
      item.inputType === 'text' && !item.name)!;
    await tools.execute({ kind: 'press', observationId: observation.observationId,
      key: 'Escape', target: { kind: 'element_ref', ref: unnamedText.ref } }, observation);
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('You entered: ESCAPE');
  } finally { await session.close(); await fixture.close(); }
});

test('typed form workflow adapts in a fresh clean context with redacted receipts', async () => {
  const fixture = await startFormFixture();
  const contextFactory = factory();
  let browsers = 0;
  const model: MinimalModel = {
    async choose(input) {
      const observationId = input.observation.observationId;
      const byName = (name: string) => ({ kind: 'element_ref' as const,
        ref: input.observation.dom.elements.find(item => item.name === name)!.ref });
      switch (input.recentReceipts.length) {
        case 0: return { kind: 'act', operation: 'fill', observationId,
          target: byName('Username'), value: 'tomsmith' };
        case 1: return { kind: 'act', operation: 'fill', observationId,
          target: byName('Password'), value: 'SuperSecretPassword!' };
        case 2: return { kind: 'act', operation: 'fill', observationId,
          target: byName('Amount'), value: '42' };
        case 3: return { kind: 'act', operation: 'select_option', observationId,
          target: { kind: 'element_ref',
            ref: input.observation.dom.elements.find(item => item.options)!.ref },
          option: { kind: 'value', value: '2' } };
        case 4: return { kind: 'act', operation: 'click', observationId,
          target: byName('Key input') };
        case 5: return { kind: 'press', observationId, key: 'Escape' };
        default: return { kind: 'done', reason: 'Observed all requested states' };
      }
    },
    async evaluate(input) {
      const elements = input.finalObservation.dom.elements;
      const hasResult = input.finalObservation.accessibility.summary.includes('You entered: ESCAPE');
      const supported = elements.find(item => item.name === 'Username')?.value === 'tomsmith' &&
        elements.find(item => item.name === 'Password')?.valuePresent === true &&
        elements.find(item => item.name === 'Amount')?.value === '42' &&
        elements.find(item => item.options)?.options?.find(item => item.value === '2')?.selected &&
        hasResult;
      const last = [...input.receipts].reverse().find(item => item.action.kind === 'press' &&
        item.delivery === 'returned' && item.observedChange);
      return { outcome: supported && last ? 'PASS' : 'INCONCLUSIVE',
        explanation: supported && last ? 'Clean form states and key response observed' :
          'Clean evidence incomplete',
        evidenceIds: [input.finalObservation.observationId, ...(last ? [last.id] : [])] };
    },
  };
  try {
    const report = await runMinimalAdaptiveAgent({
      task: { ...task(fixture.baseUrl, 'Complete the form and press Escape', 'fresh_navigation'),
        maxModelTurns: 8, maxActions: 7, maxScreenshots: 1, maxElapsedMs: 60_000 },
      model, reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
        applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      openBrowser: async () => {
        browsers++;
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      },
    });
    expect(report.outcome).toBe('PASS');
    expect(browsers).toBe(2);
    expect(report.discovery.observations[0]?.sessionId)
      .not.toBe(report.clean?.observations[0]?.sessionId);
    expect(report.clean?.resetProof).toMatchObject({ kind: 'fresh_navigation',
      initialNavigationVerified: true, applicationStateVerified: false });
    expect(report.clean?.receipts.map(item => item.delivery)).toEqual(Array(6).fill('returned'));
    expect(report.clean?.receipts.filter(item => item.action.kind === 'act' &&
      item.action.operation === 'fill').every(item =>
      item.action.kind === 'act' && 'valueRedacted' in item.action)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('SuperSecretPassword!');
  } finally { await fixture.close(); }
});

test('failed fill does not retain the proposed value in action diagnostics', async () => {
  const fixture = await startFormFixture();
  const contextFactory = factory();
  const secret = `SensitivePrefix!${'x'.repeat(600)}`;
  class RejectingFillBrowser extends AdaptiveBrowser {
    override async dispatch(...args: Parameters<AdaptiveBrowser['dispatch']>): Promise<void> {
      if (args[0].kind === 'interact' && args[0].operation === 'fill')
        throw new Error(`Rejected fill value ${secret} after validation`);
      return super.dispatch(...args);
    }
  }
  const model: MinimalModel = {
    async choose(input) {
      if (input.recentReceipts.length) return { kind: 'done', reason: 'Input rejected' };
      return { kind: 'act', operation: 'fill',
        observationId: input.observation.observationId,
        target: { kind: 'element_ref', ref: input.observation.dom.elements.find(item =>
          item.name === 'Amount')!.ref }, value: secret };
    },
    async evaluate(input) { return { outcome: 'INCONCLUSIVE',
      explanation: 'Input was rejected', evidenceIds: [input.finalObservation.observationId] }; },
  };
  try {
    const report = await runMinimalAdaptiveAgent({
      task: { ...task(fixture.baseUrl, 'Enter a valid number', 'fresh_navigation'),
        maxModelTurns: 2, maxActions: 2, maxScreenshots: 0 },
      model, reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
        applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      openBrowser: async () => {
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new RejectingFillBrowser(await session.context.newPage(), () => session.close());
      },
    });
    expect(report.outcome).toBe('INCONCLUSIVE');
    expect(report.discovery.receipts[0]?.delivery).toBe('failed');
    expect(report.discovery.receipts[0]?.error).toContain('[redacted]');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain('SensitivePrefix!');
  } finally { await fixture.close(); }
});

test('hover reveals local content and typed dialog clicks respond before click completes', async () => {
  const fixture = await startHoverDialogFixture();
  const session = await factory().open({ id: 'adaptive_minimal_test', version: '1' });
  try {
    const browser = new AdaptiveBrowser(await session.context.newPage(), () => session.close());
    const tools = new MinimalBrowserTools(browser, task(fixture.baseUrl));
    let observation = await tools.start();
    observation = await tools.screenshot(observation);
    const avatar = observation.dom.elements.filter(item => item.role === 'button' &&
      !item.name && item.bounds).sort((a, b) => a.bounds!.x - b.bounds!.x)[1]!;
    expect(avatar.bounds).toBeTruthy();
    expect(observation.accessibility.summary).not.toContain('user2');
    await tools.execute({ kind: 'act', operation: 'hover', observationId: observation.observationId,
      target: { kind: 'visual_coordinate', x: avatar.bounds!.x + avatar.bounds!.width / 2,
        y: avatar.bounds!.y + avatar.bounds!.height / 2,
        description: 'second avatar' } }, observation);
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('user2');
    const page = browser.page;
    await page.mouse.move(0, 0);
    observation = await tools.observe();
    observation = await tools.screenshot(observation);
    const surface = await page.locator('.non-control').boundingBox();
    expect(surface).toBeTruthy();
    expect(observation.dom.elements.some(item => item.name === 'Avatar 3')).toBe(false);
    await tools.execute({ kind: 'act', operation: 'hover', observationId: observation.observationId,
      target: { kind: 'visual_coordinate', x: surface!.x + surface!.width / 2,
        y: surface!.y + surface!.height / 2, description: 'third avatar surface' } }, observation);
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('user3');
    await page.mouse.move(0, 0);
    observation = await tools.observe();
    const unnamed = observation.dom.elements.filter(item => item.role === 'button' &&
      !item.name && item.bounds).sort((a, b) => a.bounds!.x - b.bounds!.x)[1]!;
    await tools.execute({ kind: 'act', operation: 'hover', observationId: observation.observationId,
      target: { kind: 'element_ref', ref: unnamed.ref } }, observation);
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('user2');
    const click = (name: string, dialog?: { kind: 'alert'; response: 'accept' } |
      { kind: 'confirm'; response: 'accept' | 'dismiss' } |
      { kind: 'prompt'; response: 'accept' | 'dismiss'; text?: string }) =>
      tools.execute({ kind: 'act', operation: 'click', observationId: observation.observationId,
        target: { kind: 'role_name', role: 'button', name }, ...(dialog ? { dialog } : {}) },
      observation);
    expect(await click('Alert', { kind: 'alert', response: 'accept' })).toEqual({
      dialog: { kind: 'alert', response: 'accept' } });
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('Alert accepted');
    expect(await click('Confirm', { kind: 'confirm', response: 'dismiss' })).toEqual({
      dialog: { kind: 'confirm', response: 'dismiss' } });
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('Cancelled');
    expect(await click('Prompt', { kind: 'prompt', response: 'accept', text: 'Adaptive QA' })).toEqual({
      dialog: { kind: 'prompt', response: 'accept' } });
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('Prompt: Adaptive QA');
    expect(await click('Normal')).toEqual({});
    observation = await tools.observe();
    expect(observation.accessibility.summary).toContain('Normal clicked');
    await expect(click('Alert', { kind: 'confirm', response: 'accept' }))
      .rejects.toThrow('UNEXPECTED_DIALOG_TYPE:alert');
    observation = await tools.observe();
    await expect(click('Normal', { kind: 'confirm', response: 'accept' }))
      .rejects.toThrow('EXPECTED_DIALOG_NOT_SEEN:confirm');
    observation = await tools.observe();
    await click('Confirm');
    observation = await tools.observe();
    // A stale expected-dialog listener would accept this; Playwright's default is dismiss.
    expect(observation.accessibility.summary).toContain('Cancelled');
  } finally { await session.close(); await fixture.close(); }
});

test('clean hover uses fresh screenshot coordinates after the target moves', async () => {
  const fixture = await startHoverDialogFixture();
  const contextFactory = factory();
  const positions: number[] = [];
  let browsers = 0;
  const model: MinimalModel = {
    async choose(input) {
      const observation = input.observation;
      if (observation.accessibility.summary.includes('user2'))
        return { kind: 'done', reason: 'Second username is visible' };
      if (!observation.screenshot) return { kind: 'observe', modality: 'screenshot' };
      const avatar = observation.dom.elements.filter(item => item.role === 'button' &&
        !item.name && item.bounds).sort((a, b) => a.bounds!.x - b.bounds!.x)[1]!;
      positions.push(avatar.bounds!.x);
      return { kind: 'act', operation: 'hover', observationId: observation.observationId,
        target: { kind: 'visual_coordinate', x: avatar.bounds!.x + avatar.bounds!.width / 2,
          y: avatar.bounds!.y + avatar.bounds!.height / 2,
          description: 'second avatar' } };
    },
    async evaluate(input) {
      const receipt = input.receipts.find(item => item.action.kind === 'act' &&
        item.action.operation === 'hover' && item.delivery === 'returned' && item.observedChange);
      const supported = input.finalObservation.accessibility.summary.includes('user2') && !!receipt;
      return { outcome: supported ? 'PASS' : 'INCONCLUSIVE',
        explanation: supported ? 'Clean hover revealed user2' : 'Clean hover evidence incomplete',
        evidenceIds: [input.finalObservation.observationId, ...(receipt ? [receipt.id] : [])] };
    },
  };
  try {
    const report = await runMinimalAdaptiveAgent({
      task: { ...task(fixture.baseUrl, 'Hover over the second avatar and confirm user2',
        'fresh_navigation'), maxModelTurns: 5, maxActions: 2, maxScreenshots: 2,
        maxElapsedMs: 60_000 },
      model, reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
        applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      openBrowser: async () => {
        browsers++;
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      },
    });
    expect(report.outcome).toBe('PASS');
    expect(browsers).toBe(2);
    expect(positions).toHaveLength(2);
    expect(positions[0]).not.toBe(positions[1]);
    expect(report.discovery.observations[0]!.sessionId)
      .not.toBe(report.clean!.observations[0]!.sessionId);
    expect(report.clean?.receipts[0]).toMatchObject({ delivery: 'returned' });
  } finally { await fixture.close(); }
});

test('clean dialog receipt records the response without retaining prompt input', async () => {
  const fixture = await startHoverDialogFixture();
  const contextFactory = factory();
  const model: MinimalModel = {
    async choose(input) {
      if (input.observation.accessibility.summary.includes('Prompt: Adaptive QA'))
        return { kind: 'done', reason: 'Prompt result visible' };
      return { kind: 'act', operation: 'click',
        observationId: input.observation.observationId,
        target: { kind: 'role_name', role: 'button', name: 'Prompt' },
        dialog: { kind: 'prompt', response: 'accept', text: 'Adaptive QA' } };
    },
    async evaluate(input) {
      const receipt = input.receipts.find(item => item.dialog?.kind === 'prompt' &&
        item.dialog.response === 'accept' && item.delivery === 'returned' && item.observedChange);
      const supported = !!receipt &&
        input.finalObservation.accessibility.summary.includes('Prompt: Adaptive QA');
      return { outcome: supported ? 'PASS' : 'INCONCLUSIVE',
        explanation: supported ? 'Clean prompt response observed' : 'Prompt evidence incomplete',
        evidenceIds: [input.finalObservation.observationId, ...(receipt ? [receipt.id] : [])] };
    },
  };
  try {
    const report = await runMinimalAdaptiveAgent({
      task: { ...task(fixture.baseUrl, 'Enter Adaptive QA in a prompt', 'fresh_navigation'),
        maxModelTurns: 3, maxActions: 1, maxScreenshots: 0 }, model,
      reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
        applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      openBrowser: async () => {
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      },
    });
    expect(report.outcome).toBe('PASS');
    expect(report.clean?.receipts[0]).toMatchObject({ delivery: 'returned',
      dialog: { kind: 'prompt', response: 'accept' } });
    expect(report.clean?.receipts[0]?.action).toMatchObject({ kind: 'act', operation: 'click',
      dialog: { kind: 'prompt', response: 'accept' } });
    expect(report.clean?.receipts[0]?.action).not.toHaveProperty('dialog.text');
    expect(report.clean?.observations[0]?.sessionId)
      .not.toBe(report.discovery.observations[0]?.sessionId);
  } finally { await fixture.close(); }
});

test('popup selection uses current page IDs and keeps popup navigation on the allowed origin', async () => {
  const fixture = await startPopupSliderFixture();
  const session = await factory().open({ id: 'adaptive_minimal_test', version: '1' });
  try {
    const browser = new AdaptiveBrowser(await session.context.newPage(), () => session.close());
    const tools = new MinimalBrowserTools(browser, task(fixture.baseUrl));
    const initial = await tools.start();
    const openerId = initial.pageId;
    await expect(tools.execute({ kind: 'act', operation: 'click',
      observationId: initial.observationId,
      target: { kind: 'role_name', role: 'link', name: 'Click Here' },
      popup: 'expect', dialog: { kind: 'alert', response: 'accept' } }, initial))
      .rejects.toThrow('ACTION_EFFECT_CONFLICT');
    expect(tools.pages()).toHaveLength(1);
    const click = (name: string, popup: 'expect') => tools.execute({ kind: 'act',
      operation: 'click', observationId: initial.observationId,
      target: { kind: 'role_name', role: 'link', name }, popup }, initial);
    const opened = await click('Click Here', 'expect');
    expect(opened.popup).toMatchObject({ url: `${fixture.baseUrl}/new` });
    expect(opened.popup?.pageId).not.toBe(openerId);
    expect(tools.pages()).toEqual(expect.arrayContaining([
      { pageId: openerId, url: `${fixture.baseUrl}/`, selected: true },
      { pageId: opened.popup!.pageId, url: `${fixture.baseUrl}/new`, selected: false },
    ]));
    let observation = await tools.observe();
    await expect(tools.execute({ kind: 'select_page', observationId: 'stale',
      pageId: opened.popup!.pageId }, observation)).rejects.toThrow('STALE_OBSERVATION');
    await tools.execute({ kind: 'select_page', observationId: observation.observationId,
      pageId: opened.popup!.pageId }, observation);
    observation = await tools.observe();
    expect(observation.pageId).toBe(opened.popup!.pageId);
    expect(observation.accessibility.summary).toContain('New Window');
    expect(tools.pages().find(page => page.selected)?.pageId).toBe(observation.pageId);
    await expect(tools.execute({ kind: 'act', operation: 'click',
      observationId: initial.observationId,
      target: { kind: 'role_name', role: 'link', name: 'Click Here' } }, initial))
      .rejects.toThrow('STALE_LIVE_PAGE');
    await tools.execute({ kind: 'select_page', observationId: observation.observationId,
      pageId: openerId }, observation);
    observation = await tools.observe();
    expect(observation.pageId).toBe(openerId);
    await expect(tools.execute({ kind: 'act', operation: 'click',
      observationId: observation.observationId,
      target: { kind: 'role_name', role: 'button', name: 'Nothing' },
      popup: 'expect' }, observation)).rejects.toThrow('EXPECTED_POPUP_NOT_SEEN');
    observation = await tools.observe();
    await expect(tools.execute({ kind: 'act', operation: 'click',
      observationId: observation.observationId,
      target: { kind: 'role_name', role: 'link', name: 'External Window' },
      popup: 'expect' }, observation)).rejects.toThrow('POPUP_ORIGIN_DENIED');
    expect(tools.pages().every(page => new URL(page.url).origin === fixture.baseUrl)).toBe(true);
  } finally { await session.close(); await fixture.close(); }
});

test('native range steps are observed and validated before bounded keyboard movement', async () => {
  const fixture = await startPopupSliderFixture();
  const session = await factory().open({ id: 'adaptive_minimal_test', version: '1' });
  try {
    const browser = new AdaptiveBrowser(await session.context.newPage(), () => session.close());
    const tools = new MinimalBrowserTools(browser, task(fixture.baseUrl));
    let observation = await tools.start();
    const range = observation.dom.elements.find(item => item.range?.step === 0.5)!;
    expect(range).toMatchObject({ inputType: 'range', value: '2.5',
      range: { min: 0, max: 5, step: 0.5, value: 2.5 } });
    const action = (value: number, ref = range.ref) => ({ kind: 'act' as const,
      operation: 'set_range' as const, observationId: observation.observationId,
      target: { kind: 'element_ref' as const, ref }, value });
    await expect(tools.execute(action(3.6), observation)).rejects.toThrow('RANGE_VALUE_UNREACHABLE');
    expect((await browser.page.locator('input[type="range"]').first().inputValue())).toBe('2.5');
    await tools.execute(action(3.5), observation);
    observation = await tools.observe();
    expect(observation.dom.elements.find(item => item.ref === range.ref)?.range?.value).toBe(3.5);
    expect(observation.accessibility.summary).toContain('3.5');
    await expect(tools.execute({ ...action(4), observationId: 'stale' }, observation))
      .rejects.toThrow('STALE_OBSERVATION');
    const anyStep = observation.dom.elements.find(item => item.range?.step === 'any')!;
    await expect(tools.execute(action(3.5, anyStep.ref), observation))
      .rejects.toThrow('RANGE_VALUE_UNREACHABLE');
    const longRange = observation.dom.elements.find(item => item.range?.max === 500)!;
    await expect(tools.execute(action(101, longRange.ref), observation))
      .rejects.toThrow('RANGE_VALUE_UNREACHABLE');
  } finally { await session.close(); await fixture.close(); }
});

test('popup workflow selects a fresh child page in the clean attempt', async () => {
  const fixture = await startPopupSliderFixture();
  const contextFactory = factory();
  const model: MinimalModel = {
    async choose(input) {
      const observationId = input.observation.observationId;
      if (input.observation.accessibility.summary.includes('New Window'))
        return { kind: 'done', reason: 'New window content visible' };
      const opened = input.recentReceipts.find(item => item.popup)?.popup;
      if (opened) return { kind: 'select_page', observationId, pageId: opened.pageId };
      return { kind: 'act', operation: 'click', observationId,
        target: { kind: 'role_name', role: 'link', name: 'Click Here' }, popup: 'expect' };
    },
    async evaluate(input) {
      const popup = input.receipts.find(item => item.popup && item.delivery === 'returned');
      const selected = input.receipts.find(item => item.action.kind === 'select_page' &&
        item.delivery === 'returned' && item.observedChange);
      const supported = !!popup && !!selected &&
        input.finalObservation.pageId === popup.popup?.pageId &&
        input.finalObservation.accessibility.summary.includes('New Window');
      return { outcome: supported ? 'PASS' : 'INCONCLUSIVE',
        explanation: supported ? 'Clean child page displays New Window' : 'Child page evidence incomplete',
        evidenceIds: [input.finalObservation.observationId,
          ...(popup ? [popup.id] : []), ...(selected ? [selected.id] : [])] };
    },
  };
  try {
    const report = await runMinimalAdaptiveAgent({
      task: { ...task(fixture.baseUrl, 'Click Here and switch to the new window',
        'fresh_navigation'), maxModelTurns: 4, maxActions: 2, maxScreenshots: 0,
        maxElapsedMs: 60_000 }, model,
      reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
        applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      openBrowser: async () => {
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      },
    });
    expect(report.outcome).toBe('PASS');
    expect(report.discovery.receipts.map(item => item.action.kind)).toEqual(['act', 'select_page']);
    expect(report.clean?.receipts.map(item => item.action.kind)).toEqual(['act', 'select_page']);
    expect(report.discovery.receipts[0]?.popup?.pageId)
      .not.toBe(report.clean?.receipts[0]?.popup?.pageId);
    expect(report.discovery.observations[0]?.sessionId)
      .not.toBe(report.clean?.observations[0]?.sessionId);
    expect(report.clean?.observations.at(-1)?.pageId)
      .not.toBe(report.clean?.observations[0]?.pageId);
    expect(report.workflow).toContain('select_page newly opened page');
    expect(report.workflow).not.toContain(report.discovery.receipts[1]?.action.kind === 'select_page'
      ? report.discovery.receipts[1].action.pageId : 'missing');
  } finally { await fixture.close(); }
});

test('native slider workflow reaches 3.5 in a fresh clean context', async () => {
  const fixture = await startPopupSliderFixture();
  const contextFactory = factory();
  const model: MinimalModel = {
    async choose(input) {
      const range = input.observation.dom.elements.find(item => item.range?.step === 0.5)!;
      if (range.range?.value === 3.5 && input.observation.accessibility.summary.includes('3.5'))
        return { kind: 'done', reason: 'Slider and displayed value observed' };
      return { kind: 'act', operation: 'set_range',
        observationId: input.observation.observationId,
        target: { kind: 'element_ref', ref: range.ref }, value: 3.5 };
    },
    async evaluate(input) {
      const range = input.finalObservation.dom.elements.find(item => item.range?.step === 0.5);
      const receipt = input.receipts.find(item => item.action.kind === 'act' &&
        item.action.operation === 'set_range' && item.delivery === 'returned' && item.observedChange);
      const supported = range?.range?.value === 3.5 &&
        input.finalObservation.accessibility.summary.includes('3.5') && !!receipt;
      return { outcome: supported ? 'PASS' : 'INCONCLUSIVE',
        explanation: supported ? 'Clean slider and output show 3.5' : 'Slider evidence incomplete',
        evidenceIds: [input.finalObservation.observationId, ...(receipt ? [receipt.id] : [])] };
    },
  };
  try {
    const report = await runMinimalAdaptiveAgent({
      task: { ...task(fixture.baseUrl, 'Set the slider to 3.5', 'fresh_navigation'),
        maxModelTurns: 3, maxActions: 1, maxScreenshots: 0, maxElapsedMs: 60_000 }, model,
      reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
        applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      openBrowser: async () => {
        const session = await contextFactory.open({ id: 'adaptive_minimal_test', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      },
    });
    expect(report.outcome).toBe('PASS');
    expect(report.clean?.receipts[0]?.observedChange).toBeTruthy();
    expect(report.discovery.observations[0]?.sessionId)
      .not.toBe(report.clean?.observations[0]?.sessionId);
  } finally { await fixture.close(); }
});
