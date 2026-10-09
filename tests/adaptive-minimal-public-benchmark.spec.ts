import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { runMinimalAdaptiveAgent } from '../app/adaptive-minimal/controller.js';
import { OpenAIMinimalModel } from '../app/adaptive-minimal/model.js';
import type { Attempt, MinimalModel, MinimalResult, MinimalTask,
  Receipt } from '../app/adaptive-minimal/types.js';
import { startAdaptiveFixture } from './support/adaptive-fixture.js';

// Only public starting URLs and authored instructions are scenario data.
const scenarios = [
  { url: 'https://the-internet.herokuapp.com/challenging_dom',
    instruction: 'Click the red button. Confirm that the visible text of at least one button changes after the click.' },
  { url: 'https://the-internet.herokuapp.com/add_remove_elements/',
    instruction: 'Confirm that there is initially no Delete button. Click Add Element. Confirm that a Delete button appears.' },
  { url: 'https://the-internet.herokuapp.com/large',
    instruction: 'Find the text 45.10 and confirm that 44.10 appears directly above it.' },
  { url: 'https://the-internet.herokuapp.com/shadowdom',
    instruction: "Confirm that there are two gray boxes. One contains 'Let's have some different text'. The other contains the same text followed, on a new line, by 'In a list!'." },
  { url: 'https://the-internet.herokuapp.com/dynamic_controls',
    instruction: 'Confirm a checkbox is present. Click Remove and wait until the checkbox disappears. Click Add and confirm the checkbox reappears.' },
  { url: 'https://the-internet.herokuapp.com/checkboxes',
    instruction: 'Ensure checkbox 1 is checked and checkbox 2 is unchecked. Confirm both final states.' },
  { url: 'https://the-internet.herokuapp.com/dynamic_loading/1',
    instruction: 'Confirm Hello World! is initially hidden. Click Start, wait for loading to complete, and confirm Hello World! becomes visible.' },
  { url: 'https://the-internet.herokuapp.com/tables',
    instruction: 'In Example 1, find Frank Bach. Confirm his email is fbach@yahoo.com and his amount due is $51.00.' },
  { url: 'https://the-internet.herokuapp.com/broken_images',
    instruction: 'Inspect the three images. Determine how many are broken and how many render correctly.' },
  { url: 'https://the-internet.herokuapp.com/login',
    instruction: 'Enter username tomsmith and password SuperSecretPassword!, click Login, and confirm that authentication succeeds.' },
  { url: 'https://the-internet.herokuapp.com/dropdown',
    instruction: 'Select Option 2 and confirm that Option 2 is selected.' },
  { url: 'https://the-internet.herokuapp.com/inputs',
    instruction: 'Enter 42 into the number input and confirm that the field value is 42.' },
  { url: 'https://the-internet.herokuapp.com/key_presses',
    instruction: 'Focus the input, press Escape, and confirm that the page reports You entered: ESCAPE.' },
  { url: 'https://the-internet.herokuapp.com/hovers',
    instruction: 'Hover over the second avatar and confirm that the revealed username is user2.' },
  { url: 'https://the-internet.herokuapp.com/javascript_alerts',
    instruction: 'Click Click for JS Alert, accept the alert, and confirm that the result says You successfully clicked an alert.' },
  { url: 'https://the-internet.herokuapp.com/javascript_alerts',
    instruction: 'Click Click for JS Confirm, dismiss the dialog, and confirm that the result says You clicked: Cancel.' },
  { url: 'https://the-internet.herokuapp.com/javascript_alerts',
    instruction: 'Click Click for JS Prompt, enter Adaptive QA into the prompt, accept it, and confirm that the result says You entered: Adaptive QA.' },
  { url: 'https://the-internet.herokuapp.com/windows',
    instruction: 'Click Click Here, switch to the newly opened window, and confirm that it displays New Window.' },
  { url: 'https://the-internet.herokuapp.com/horizontal_slider',
    instruction: 'Set the slider to 3.5 and confirm that the displayed value is 3.5.' },
] as const;

function actionOperation(action: Receipt['action']): string {
  return action.kind === 'act' ? action.operation : action.kind;
}
function actionTargetKind(action: Receipt['action']): string {
  return action.kind === 'navigate' ? 'url' : action.kind === 'select_page' ? 'page' :
    action.target?.kind ?? 'focused_page';
}
function redactPassword(text: string, instruction: string): string {
  return [...instruction.matchAll(/\bpassword\s+([^\s,;]+)/gi)]
    .reduce((safe, match) => safe.replaceAll(match[1]!, '[redacted]'), text);
}

function summary(attempt: Attempt | undefined) {
  if (!attempt) return null;
  return { stop: attempt.stopReason, hasStopDetail: !!attempt.stopDetail,
    reset: { kind: attempt.resetProof.kind ?? 'application_reset',
      freshBrowserContext: attempt.resetProof.freshBrowserContext,
      applicationStateVerified: attempt.resetProof.applicationStateVerified,
      initialNavigationVerified: attempt.resetProof.initialNavigationVerified ?? false },
    actions: attempt.receipts.map(item => ({ operation: actionOperation(item.action),
      targetKind: actionTargetKind(item.action),
      ...(item.action.kind === 'act' && item.action.operation === 'set_range'
        ? { requestedRangeValue: item.action.value } : {}),
      delivery: item.delivery, observedChange: !!item.observedChange,
      ...(item.dialog ? { dialog: item.dialog } : {}),
      ...(item.popup ? { popupOpened: true } : {}),
      ...(item.error ? { errorCategory: item.diagnostic?.ariaSnapshotTimedOut
        ? 'aria_snapshot_timeout' : item.error.includes('TARGET_NOT_GROUNDED')
          ? 'target_not_grounded' : 'other' } : {}),
      ...(item.diagnostic ? { postAction: {
        urlChanged: item.diagnostic.currentUrl !== attempt.observations.find(
          observation => observation.observationId === item.beforeId)?.url,
        mainFrameNavigations: item.diagnostic.mainFrameNavigations,
        documentLoads: item.diagnostic.documentLoads,
        bodyAttached: item.diagnostic.bodyAttached ?? 'unknown',
        documentReadyState: item.diagnostic.documentReadyState ?? 'unknown',
        ariaSnapshotTimedOut: item.diagnostic.ariaSnapshotTimedOut,
      } } : {}) })),
    observations: attempt.observations.map(item => ({
      urlChangedFromStart: item.url !== attempt.observations[0]?.url,
      pageChangedFromStart: item.pageId !== attempt.observations[0]?.pageId,
      controls: item.dom.elements.length, accessibilityChars: item.accessibility.summary.length,
      screenshot: !!item.screenshot })),
    screenshotsUsed: attempt.observations.filter(item => !!item.screenshot).length };
}

function privateActionEvidence(result: MinimalResult, instruction: string) {
  const boundedUrl = (url: string | undefined) => url?.slice(0, 4096);
  const safe = (value: string | undefined) => value === undefined ? undefined
    : redactPassword(value, instruction);
  const actions = (attempt: Attempt | undefined) => attempt?.receipts.map(item => ({
    id: item.id, operation: actionOperation(item.action),
    targetKind: actionTargetKind(item.action),
    ...(item.action.kind === 'navigate' ? { navigationDestination: safe(item.action.url) } : {}),
    ...(item.action.kind === 'select_page' ? { selectedPageId: item.action.pageId } : {}),
    ...(item.action.kind === 'act' && item.action.operation === 'set_range'
      ? { requestedRangeValue: item.action.value } : {}),
    beforePageId: attempt.observations.find(observation =>
      observation.observationId === item.beforeId)?.pageId,
    afterPageId: attempt.observations.find(observation =>
      observation.observationId === item.afterId)?.pageId,
    beforeUrl: safe(boundedUrl(attempt.observations.find(observation =>
      observation.observationId === item.beforeId)?.url)),
    afterUrl: safe(boundedUrl(attempt.observations.find(observation =>
      observation.observationId === item.afterId)?.url)),
    delivery: item.delivery, ...(item.dialog ? { dialog: item.dialog } : {}),
    ...(item.popup ? { popup: { pageId: item.popup.pageId,
      url: safe(boundedUrl(item.popup.url)) } } : {}),
    observationError: safe(item.error?.slice(0, 500)),
    postAction: item.diagnostic ? { ...item.diagnostic,
      currentUrl: safe(boundedUrl(item.diagnostic.currentUrl)) } : undefined,
  })) ?? [];
  return { discovery: actions(result.discovery), clean: actions(result.clean),
    discoveryStopDetail: safe(result.discovery.stopDetail?.slice(0, 500)),
    cleanStopDetail: safe(result.clean?.stopDetail?.slice(0, 500)),
    evaluatorExplanation: safe(result.explanation.slice(0, 1200)) };
}

async function saveAttachment(testInfo: TestInfo, name: string, body: Buffer, contentType: string) {
  const path = testInfo.outputPath(name);
  await writeFile(path, body);
  await testInfo.attach(name, { path, contentType });
  return path;
}

async function openBenchmarkBrowser(browser: Browser, onPage?: (page: Page) => void) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    onPage?.(page);
    return new AdaptiveBrowser(page, () => context.close());
  } catch (error) { await context.close(); throw error; }
}

test('offline benchmark evidence files persist', async ({ page }, testInfo) => {
  test.skip(process.env.ADAPTIVE_MINIMAL_ARTIFACT_SELFTEST !== '1',
    'Requires explicit offline artifact check');
  const diagnosticPath = await saveAttachment(testInfo, 'minimal-public-offline-diagnostic.json',
    Buffer.from(JSON.stringify({ observationId: 'offline-observation' })), 'application/json');
  await page.goto('data:text/html,<h1>Offline evidence</h1>');
  const screenshotPath = await saveAttachment(testInfo, 'clean-final-offline-observation.jpg',
    await page.screenshot({ type: 'jpeg' }), 'image/jpeg');
  expect(JSON.parse(await readFile(diagnosticPath, 'utf8'))).toEqual({ observationId: 'offline-observation' });
  expect((await readFile(screenshotPath)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  console.log(`ADAPTIVE_MINIMAL_ARTIFACT_SELFTEST=${JSON.stringify({ diagnosticPath, screenshotPath })}`);
});

test('offline public benchmark opens separate contexts without trusted configuration',
  async ({ browser }) => {
    test.skip(process.env.ADAPTIVE_MINIMAL_BROWSER_SELFTEST !== '1',
      'Requires explicit offline browser check');
    const fixture = await startAdaptiveFixture('a', () => 0);
    const contextsBefore = browser.contexts().length;
    const openedContexts = new Set<ReturnType<Page['context']>>();
    const model: MinimalModel = {
      async choose(input) {
        if (input.phase === 'discovery' && input.recentReceipts.length === 0)
          return { kind: 'navigate', observationId: input.observation.observationId,
            url: 'https://example.org/' };
        return { kind: 'done', reason: 'Offline observation complete' };
      },
      async evaluate(input) { return { outcome: 'INCONCLUSIVE', explanation: 'No action attempted',
        evidenceIds: [input.finalObservation.observationId] }; },
    };
    try {
      const result = await runMinimalAdaptiveAgent({
        task: { instruction: 'Observe the home page', startUrl: `${fixture.baseUrl}/`,
          allowedOrigins: [fixture.baseUrl], resetRef: 'fresh_navigation',
          maxModelTurns: 2, maxActions: 2, maxScreenshots: 1, maxElapsedMs: 20_000 },
        model, openBrowser: async () => {
          const adapter = await openBenchmarkBrowser(browser);
          openedContexts.add(adapter.page.context());
          return adapter;
        },
        reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
          applicationStateVerified: false, resetRef: 'fresh_navigation' }),
      });
      expect(result.discovery.observations[0]?.url).toBe(`${fixture.baseUrl}/`);
      expect(result.discovery.receipts[0]).toMatchObject({ delivery: 'failed',
        error: 'NAVIGATION_DENIED' });
      expect(result.clean?.observations[0]?.url).toBe(`${fixture.baseUrl}/`);
      expect(result.discovery.observations[0]?.sessionId)
        .not.toBe(result.clean?.observations[0]?.sessionId);
      expect(openedContexts.size).toBe(2);
      expect(result.clean?.resetProof).toMatchObject({ initialNavigationVerified: true,
        applicationStateVerified: false });
      expect(result.outcome).toBe('INCONCLUSIVE');
      expect(browser.contexts()).toHaveLength(contextsBefore);
    } finally { await fixture.close(); }
  });

test.describe.configure({ retries: 0 });
for (const [index, scenario] of scenarios.entries()) {
  test(`opt-in public minimal benchmark ${index + 1}`, async ({ browser }, testInfo) => {
    test.skip(process.env.ADAPTIVE_MINIMAL_PUBLIC_BENCHMARK !== '1' ||
      !process.env.OPENAI_API_KEY || !process.env.ADAPTIVE_LIVE_MODEL,
    'Requires explicit public benchmark opt-in, model, and credential');
    test.setTimeout(240_000);
    const origin = new URL(scenario.url).origin;
    const task: MinimalTask = { instruction: scenario.instruction, startUrl: scenario.url,
      allowedOrigins: [origin], resetRef: 'fresh_navigation',
      maxModelTurns: 12, maxActions: 6, maxScreenshots: 3, maxElapsedMs: 180_000 };
    const started = Date.now();
    const limits = { modelTurnsPerAttempt: task.maxModelTurns, actionsPerAttempt: task.maxActions,
      screenshotsPerAttempt: task.maxScreenshots, totalMs: task.maxElapsedMs,
      operations: ['click', 'check', 'uncheck', 'fill', 'select_option',
        'press', 'hover', 'navigate', 'select_page', 'set_range'],
      applicationReset: 'unverified; fresh context and exact start navigation only' };
    let finalScreenshotArtifact: string | undefined;
    const browserEvents: { phase: string; kind: string; url: string;
      status?: number; failure?: string; at: string }[] = [];
    let browserCount = 0;
    try {
      const result = await runMinimalAdaptiveAgent({ task,
        model: new OpenAIMinimalModel(process.env.OPENAI_API_KEY!, process.env.ADAPTIVE_LIVE_MODEL!),
        openBrowser: () => openBenchmarkBrowser(browser, page => {
          const phase = browserCount++ === 0 ? 'discovery' : 'clean';
          const record = (kind: string, url: string, status?: number, failure?: string) => {
            if (browserEvents.length < 80) browserEvents.push({ phase, kind,
              url: url.slice(0, 4096),
              ...(status === undefined ? {} : { status }),
              ...(failure ? { failure: failure.slice(0, 160) } : {}), at: new Date().toISOString() });
          };
          page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) record('main_frame_navigated', frame.url());
          });
          page.on('domcontentloaded', () => record('dom_content_loaded', page.url()));
          page.on('response', response => {
            try {
              const request = response.request();
              if (request.isNavigationRequest() && request.frame() === page.mainFrame())
                record('main_frame_response', response.url(), response.status());
            } catch { /* Diagnostics must not affect browser execution. */ }
          });
          page.on('requestfailed', request => {
            try {
              if (request.isNavigationRequest() && request.frame() === page.mainFrame())
                record('main_frame_request_failed', request.url(), undefined,
                  request.failure()?.errorText);
            } catch { /* Diagnostics must not affect browser execution. */ }
          });
          page.on('pageerror', error => record('page_error', page.url(), undefined, error.message));
          page.on('crash', () => record('page_crash', page.url()));
        }),
        onCleanFinalScreenshot: async image => {
          const name = `clean-final-${image.observationId}.jpg`;
          await saveAttachment(testInfo, name, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),
            'image/jpeg');
          finalScreenshotArtifact = name;
        },
        // A new context and exact start-page navigation are the only public reset claims.
        reset: async () => ({ kind: 'fresh_navigation', freshBrowserContext: true,
          applicationStateVerified: false, resetRef: 'fresh_navigation' }) });
      let diagnosticArtifact: string | undefined;
      try {
        const name = `minimal-public-${index + 1}-browser-diagnostic.json`;
        await saveAttachment(testInfo, name, Buffer.from(JSON.stringify({
          actions: privateActionEvidence(result, scenario.instruction),
          browserEvents: browserEvents.map(event => ({ ...event,
            url: redactPassword(event.url, scenario.instruction),
            ...(event.failure ? { failure: redactPassword(event.failure, scenario.instruction) } : {}) })),
          finalScreenshotObservationId: result.clean?.observations.at(-1)?.screenshot
            ? result.clean.observations.at(-1)?.observationId : undefined,
        })), 'application/json');
        diagnosticArtifact = name;
      } catch { /* Artifact storage is diagnostic and does not change the verdict. */ }
      console.log(`ADAPTIVE_MINIMAL_PUBLIC_${index + 1}=${JSON.stringify({
        url: scenario.url, instruction: redactPassword(scenario.instruction, scenario.instruction),
        discovery: summary(result.discovery), clean: summary(result.clean),
        verdict: result.outcome,
        evidenceIds: result.evidenceIds,
        ...(diagnosticArtifact ? { diagnosticArtifact } : {}),
        ...(finalScreenshotArtifact ? { finalScreenshotArtifact } : {}),
        runtimeMs: Date.now() - started, limits })}`);
    } catch {
      console.log(`ADAPTIVE_MINIMAL_PUBLIC_${index + 1}=${JSON.stringify({
        url: scenario.url, instruction: redactPassword(scenario.instruction, scenario.instruction),
        discovery: null, clean: null,
        verdict: 'INCONCLUSIVE', evidenceIds: [], runtimeMs: Date.now() - started,
        limits, failureCode: 'BENCHMARK_RUNTIME_ERROR' })}`);
    }
  });
}
